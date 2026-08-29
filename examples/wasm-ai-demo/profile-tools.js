function functionTool(name, description, properties, required) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        required,
      },
    },
  };
}

export const DEMO_TOOLS = [
  functionTool(
    "request_document_lookup",
    "Request a search of documents imported into the local Arcane document library. SDK Chat displays this structural call, but the example does not execute it as a tool action.",
    {
      query: { type: "string" },
      message: {
        type: "string",
        minLength: 1,
        description: "An honest user-facing explanation of the proposed lookup that does not claim the lookup ran.",
      },
    },
    ["query", "message"],
  ),
  functionTool(
    "draft_local_note",
    "Draft a complete local note for the user. SDK Chat displays this structural call, but the example does not store or send it.",
    {
      title: { type: "string" },
      body: { type: "string" },
      message: {
        type: "string",
        minLength: 1,
        description: "An honest user-facing explanation of the proposed note that does not claim it was stored or sent.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
      },
    },
    ["title", "body", "message"],
  ),
];

export function toolsForProfile(profileId) {
  return profileId === "tools" ? DEMO_TOOLS : [];
}
