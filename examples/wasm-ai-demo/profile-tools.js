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

function numericProperties(names) {
  return Object.fromEntries(names.map((name) => [name, { type: "number" }]));
}

function messageProperty(description) {
  return {
    type: "string",
    minLength: 1,
    description,
  };
}

function propertiesWithMessage(properties, description) {
  return {
    ...properties,
    message: messageProperty(description),
  };
}

function requiredWithMessage(required) {
  return [...required, "message"];
}

const CRISIS_FIELDS = [
  "crisis",
  "crisis_prediction",
  "immediate_intervention_required",
];

const RISK_FIELDS = [
  "possible_danger_to_others",
  "possibly_in_danger_from_others",
  "possible_danger_to_self",
  "possible_danger_to_property",
  "possible_danger_to_animals",
  "possible_sexual_danger_to_others",
  "possibly_in_sexual_danger_from_others",
  "possible_sexual_danger_to_self",
  "possibly_in_danger_from_coercion",
  "propensity_for_terroristic_activity",
  "propensity_to_violate_the_law",
  "propensity_to_be_deceitful",
];

const RELATIONSHIP_RISK_FIELDS = [
  "possibly_in_abusive_relationship",
  "possibly_in_emotionally_abusive_relationship",
  "possibly_in_socially_abusive_relationship",
  "possibly_in_physically_abusive_relationship",
  "possibly_in_financially_abusive_relationship",
  "propensity_to_be_abusive",
];

const ASSESSMENT_FIELDS = [
  "major_depression",
  "stress",
  "anxiety",
  "functionality",
  "disfunctionality",
  "environmental_MH_impact",
  "trauma",
  "resilience",
  "self_sabotage",
  "self_confidence",
  "religious_trauma",
  "controlling_personality",
  "narcisistic_personality",
  "stability",
  "instability",
  "suicidal_ideation",
  "homicidal_ideation",
  "anger_issues",
  "chronic_pain",
  "PTSD",
  "panic_disorder",
  "substance_use_disorder",
  "dissociative_disorders",
  "borderline_personality_disorder",
  "neurocognitive_disorder",
  "personality_disorder",
  "eating_disorder",
  "schizophrenia",
  "manic",
  "bipolar",
  "cognitive_dissonance",
  "ocd",
  "phobias",
  "paraphilic_disorder",
  "other_psychotic_disorders",
  "honesty",
  "dishonesty",
  "moral_trauma",
  "betrayal",
];

const ASSESSMENT_MESSAGE = "A clear user-facing explanation of the assessment update that does not claim the displayed tool call was executed.";

export const PRECRISIS_TOOLS = [
  functionTool(
    "crisis_detection",
    "Report detected or developing mental-health crisis risk using the profile's canonical numeric fields.",
    propertiesWithMessage(numericProperties(CRISIS_FIELDS), ASSESSMENT_MESSAGE),
    requiredWithMessage(CRISIS_FIELDS),
  ),
  functionTool(
    "possible_risks",
    "Report possible or imminent risks to self, others, property, animals, or safety.",
    propertiesWithMessage(numericProperties(RISK_FIELDS), ASSESSMENT_MESSAGE),
    requiredWithMessage(RISK_FIELDS),
  ),
  functionTool(
    "possible_risks_relationship",
    "Report possible relationship risks involving emotional, social, physical, or financial abuse.",
    propertiesWithMessage(numericProperties(RELATIONSHIP_RISK_FIELDS), ASSESSMENT_MESSAGE),
    requiredWithMessage(RELATIONSHIP_RISK_FIELDS),
  ),
  functionTool(
    "fitness_for_service",
    "Report whether an individual appears fit to serve or lead others in military or government work.",
    propertiesWithMessage(numericProperties(["serve", "lead"]), ASSESSMENT_MESSAGE),
    requiredWithMessage(["serve", "lead"]),
  ),
  functionTool(
    "assessment_complete",
    "Return the profile's structured mental-health assessment ratings when the assessment is complete.",
    propertiesWithMessage(numericProperties(ASSESSMENT_FIELDS), ASSESSMENT_MESSAGE),
    requiredWithMessage(ASSESSMENT_FIELDS),
  ),
  functionTool(
    "text_assessment",
    "Return the profile's narrative assessment, possible treatment options, and support-network topics.",
    propertiesWithMessage({
      mental_health_assessment: { type: "string" },
      treatment_options: { type: "string" },
      topics_of_discussion_or_activities: { type: "string" },
    }, ASSESSMENT_MESSAGE),
    requiredWithMessage([
      "mental_health_assessment",
      "treatment_options",
      "topics_of_discussion_or_activities",
    ]),
  ),
];

const BOSS_MESSAGE = "A short, honest user-facing status or handoff explanation that does not claim an application action was executed.";

export const BOSS_TOOLS = [
  functionTool(
    "prepare_boss_handoff",
    "Prepare a library-backed handoff to an appropriate person, role, or organization.",
    {
      query: { type: "string" },
      message: messageProperty(BOSS_MESSAGE),
    },
    ["query", "message"],
  ),
  functionTool(
    "conversation_timebox",
    "Set, adjust, or clear the current conversation time check using exact whole milliseconds.",
    {
      action: { type: "string", enum: ["set", "adjust", "clear"] },
      duration_milliseconds: { type: "integer" },
      message: messageProperty(BOSS_MESSAGE),
    },
    ["action", "message"],
  ),
  functionTool(
    "set_lifecycle_stage",
    "Store an explicitly established business lifecycle stage, or clear it with stage 0.",
    {
      stage: { type: "integer", enum: [0, 1, 2, 3, 4, 5, 6] },
      message: messageProperty(BOSS_MESSAGE),
    },
    ["stage", "message"],
  ),
  functionTool(
    "prepare_boss_closing_report",
    "Prepare the final BOSS response and only explicitly agreed follow-ups. This does not send or execute anything.",
    {
      final_message: { type: "string" },
      remembered_actions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            basis: { type: "string", enum: ["user_commitment", "optional_homework"] },
          },
          required: ["text", "basis"],
        },
      },
      message: messageProperty(BOSS_MESSAGE),
    },
    ["final_message", "message"],
  ),
];

export function toolsForProfile(profileId) {
  if (profileId === "precrisis") return PRECRISIS_TOOLS;
  if (profileId === "boss") return BOSS_TOOLS;
  return [];
}
