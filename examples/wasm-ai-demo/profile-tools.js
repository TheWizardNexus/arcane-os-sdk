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
    "Request a search of documents imported into the local Arcane document library. The example displays this structural call but does not execute it as a tool action.",
    {
      query: { type: "string" },
      explanation: { type: "string" },
    },
    ["query", "explanation"],
  ),
  functionTool(
    "draft_local_note",
    "Draft a complete local note for the user. The example displays this structural call but does not store or send it.",
    {
      title: { type: "string" },
      body: { type: "string" },
      tags: {
        type: "array",
        items: { type: "string" },
      },
    },
    ["title", "body"],
  ),
];

export function toolsForProfile(profileId) {
  return profileId === "tools" ? DEMO_TOOLS : [];
}
