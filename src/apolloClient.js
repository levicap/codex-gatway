import { DEFAULT_EXECUTIVE_TITLES, cleanDomain } from "./company.js";

function firstNonEmpty(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || "";
}

export function normalizeApolloPerson(person, includeEmails) {
  const firstName = firstNonEmpty(person.first_name, person.firstName);
  const lastName = firstNonEmpty(person.last_name, person.lastName);
  const firstLastName = [firstName, lastName].filter(Boolean).join(" ").trim();
  const fallbackName = firstNonEmpty(person.full_name, person.name);
  const organization = person.organization || person.current_organization || {};
  const workEmail = firstNonEmpty(person.email, person.email_address, person.work_email);
  const personalEmails = Array.isArray(person.personal_emails) ? person.personal_emails : [];
  const personalEmail = includeEmails ? firstNonEmpty(...personalEmails) : "";
  const email = workEmail || personalEmail;
  const normalized = {
    personId: firstNonEmpty(person.person_id, person.id),
    firstName,
    lastName,
    name: firstLastName || fallbackName,
    title: firstNonEmpty(person.title),
    organizationName: firstNonEmpty(organization.name, person.organization_name),
    linkedinUrl: firstNonEmpty(person.linkedin_url, person.linkedin, person.linkedin_profile_url),
    city: firstNonEmpty(person.city),
    state: firstNonEmpty(person.state),
    country: firstNonEmpty(person.country),
    seniority: firstNonEmpty(person.seniority),
    departments: Array.isArray(person.departments) ? person.departments : [],
    email,
    emailType: email ? (workEmail ? "apollo_work" : "apollo_personal") : "",
    emailStatus: firstNonEmpty(person.email_status),
    confidence: 0.85
  };

  return normalized;
}

function pickPeople(data) {
  if (Array.isArray(data?.people)) return data.people;
  if (Array.isArray(data?.contacts)) return data.contacts;
  if (Array.isArray(data?.mixed_people)) return data.mixed_people;
  return [];
}

export function pathJoin(baseUrl, endpointPath) {
  const path = endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`;
  return `${baseUrl}${path}`;
}

function mergePerson(base, enriched) {
  if (!enriched) return base;
  return {
    ...base,
    ...Object.fromEntries(
      Object.entries(enriched).filter(([, value]) => {
        if (Array.isArray(value)) return value.length > 0;
        return value !== undefined && value !== null && value !== "";
      })
    ),
    source: "apollo_search+apollo_enrichment",
    confidence: Math.max(Number(base.confidence || 0.85), Number(enriched.confidence || 0.9))
  };
}

export async function enrichApolloPerson(person, { domain, companyName }, config) {
  const params = new URLSearchParams();
  if (person.personId) params.set("id", person.personId);
  if (person.linkedinUrl) params.set("linkedin_url", person.linkedinUrl);
  if (person.name) params.set("name", person.name);
  if (person.firstName) params.set("first_name", person.firstName);
  if (person.lastName) params.set("last_name", person.lastName);
  if (domain) params.set("domain", domain);
  if (companyName || person.organizationName) {
    params.set("organization_name", person.organizationName || companyName);
  }
  params.set("reveal_personal_emails", String(Boolean(config.apollo.includeEmails)));

  const url = `${pathJoin(config.apollo.baseUrl, config.apollo.peopleEnrichmentPath)}?${params.toString()}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "X-Api-Key": config.apollo.apiKey
    }
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message = data.error || data.message || text || response.statusText;
    throw new Error(`Apollo people enrichment failed with ${response.status}: ${message}`);
  }

  const enrichedPerson = data.person || data.contact || data;
  return normalizeApolloPerson(enrichedPerson, config.apollo.includeEmails);
}

export async function searchApolloExecutives({ companyName, domain, limit }, config) {
  if (!config.apollo.apiKey) {
    return {
      status: "skipped_missing_api_key",
      executives: [],
      total: 0,
      error: "APOLLO_API_KEY is not configured."
    };
  }

  const clean = cleanDomain(domain);
  if (!clean && !companyName) {
    return {
      status: "skipped_missing_company_identifier",
      executives: [],
      total: 0,
      error: "No domain or company name available for Apollo search."
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.apollo.timeoutMs);
  const url = pathJoin(config.apollo.baseUrl, config.apollo.peopleSearchPath);

  const body = {
    page: 1,
    per_page: Math.min(Math.max(limit * 3, 10), 50),
    person_titles: DEFAULT_EXECUTIVE_TITLES,
    person_seniorities: ["owner", "founder", "c_suite", "vp", "head"],
    include_similar_titles: false
  };

  if (clean) {
    body.q_organization_domains_list = [clean];
  } else {
    body.q_organization_name = companyName;
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "X-Api-Key": config.apollo.apiKey
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      const message = data.error || data.message || text || response.statusText;
      return {
        status: "failed",
        executives: [],
        total: 0,
        endpoint: url,
        error: `Apollo request failed with ${response.status}: ${message}`
      };
    }

    const people = pickPeople(data);
    let executives = people
      .map((person) => normalizeApolloPerson(person, config.apollo.includeEmails))
      .filter((person) => person.name && person.title);
    const warnings = [];
    let enrichedCount = 0;

    if (config.apollo.enrichPeople && config.apollo.enrichLimit > 0) {
      const maxEnrich = Math.min(limit, config.apollo.enrichLimit, executives.length);
      const enrichedExecutives = [];

      for (const person of executives.slice(0, maxEnrich)) {
        try {
          const enriched = await enrichApolloPerson(person, { domain: clean, companyName }, config);
          enrichedExecutives.push(mergePerson(person, enriched));
          enrichedCount += 1;
        } catch (error) {
          warnings.push(`${person.name}: ${error.message}`);
          enrichedExecutives.push(person);
        }
      }

      executives = [...enrichedExecutives, ...executives.slice(maxEnrich)];
    }

    return {
      status: "completed",
      executives,
      total: Number(data.pagination?.total_entries || data.total_entries || executives.length),
      endpoint: url,
      enrichmentEndpoint: config.apollo.enrichPeople ? pathJoin(config.apollo.baseUrl, config.apollo.peopleEnrichmentPath) : null,
      enrichedCount,
      warnings
    };
  } catch (error) {
    return {
      status: "failed",
      executives: [],
      total: 0,
      endpoint: url,
      error: error.name === "AbortError" ? `Apollo timed out after ${config.apollo.timeoutMs}ms.` : error.message
    };
  } finally {
    clearTimeout(timeout);
  }
}
