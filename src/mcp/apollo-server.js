import readline from "node:readline";
import { config } from "../config.js";
import { cleanDomain } from "../company.js";
import { enrichApolloPerson, searchApolloExecutives } from "../apolloClient.js";

const tools = [
  {
    name: "apollo_people_search",
    description:
      "Search Apollo for likely key executives at a company. Use this to verify or supplement web research with names, titles, LinkedIn URLs, work emails when available, and Apollo person IDs.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        companyName: {
          type: "string",
          description: "Company name, used when domain is not available."
        },
        domain: {
          type: "string",
          description: "Company website domain, for example openai.com."
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 25,
          default: 10
        }
      }
    }
  },
  {
    name: "apollo_people_enrich",
    description:
      "Enrich one Apollo person or named executive. Use this after web search or Apollo search to fill missing LinkedIn URL, title, location, work email when available, and Apollo person ID.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        personId: {
          type: "string",
          description: "Apollo person_id or id from people search."
        },
        name: {
          type: "string",
          description: "Full name of the person."
        },
        firstName: {
          type: "string"
        },
        lastName: {
          type: "string"
        },
        title: {
          type: "string"
        },
        linkedinUrl: {
          type: "string"
        },
        domain: {
          type: "string",
          description: "Company website domain, for example openai.com."
        },
        companyName: {
          type: "string"
        },
        organizationName: {
          type: "string"
        }
      }
    }
  }
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function toolResult(id, value) {
  send({
    jsonrpc: "2.0",
    id,
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify(value, null, 2)
        }
      ]
    }
  });
}

function toolError(id, error) {
  send({
    jsonrpc: "2.0",
    id,
    result: {
      isError: true,
      content: [
        {
          type: "text",
          text: error.message || String(error)
        }
      ]
    }
  });
}

async function callTool(name, args = {}) {
  if (name === "apollo_people_search") {
    return searchApolloExecutives(
      {
        companyName: String(args.companyName || ""),
        domain: cleanDomain(args.domain || ""),
        limit: Number(args.limit || 10)
      },
      config
    );
  }

  if (name === "apollo_people_enrich") {
    const person = {
      personId: String(args.personId || ""),
      name: String(args.name || ""),
      firstName: String(args.firstName || ""),
      lastName: String(args.lastName || ""),
      title: String(args.title || ""),
      linkedinUrl: String(args.linkedinUrl || ""),
      organizationName: String(args.organizationName || args.companyName || "")
    };

    return enrichApolloPerson(
      person,
      {
        domain: cleanDomain(args.domain || ""),
        companyName: String(args.companyName || args.organizationName || "")
      },
      config
    );
  }

  throw new Error(`Unknown Apollo tool: ${name}`);
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

rl.on("line", async (line) => {
  if (!line.trim()) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    console.error(`Invalid MCP JSON: ${error.message}`);
    return;
  }

  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion || "2024-11-05",
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: "apollo-mcp",
          version: "1.0.0"
        }
      }
    });
    return;
  }

  if (message.method === "notifications/initialized") {
    return;
  }

  if (message.method === "ping") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }

  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { tools }
    });
    return;
  }

  if (message.method === "tools/call") {
    try {
      const result = await callTool(message.params?.name, message.params?.arguments || {});
      toolResult(message.id, result);
    } catch (error) {
      toolError(message.id, error);
    }
    return;
  }

  if (message.id !== undefined) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32601,
        message: `Unsupported method: ${message.method}`
      }
    });
  }
});
