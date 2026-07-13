"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/volcengine-aicc/provider-discovery.ts
var provider_discovery_exports = {};
__export(provider_discovery_exports, {
  default: () => provider_discovery_default,
  volcengineAiccProviderDiscovery: () => volcengineAiccProviderDiscovery
});
module.exports = __toCommonJS(provider_discovery_exports);

// src/volcengine-aicc/src/models.ts
var VOLCENGINE_AICC_BASE_URL = "https://sd77a0f4ummt3i4vnems0.apigateway-cn-beijing.volceapi.com/api/v3";
var VOLCENGINE_AICC_DEFAULT_MODEL_ID = "doubao-seed-2.0-pro";
var VOLCENGINE_AICC_DEFAULT_MODEL_REF = `volcengine-aicc/${VOLCENGINE_AICC_DEFAULT_MODEL_ID}`;
var VOLCENGINE_AICC_DEFAULT_COST = {
  input: 1e-4,
  output: 2e-4,
  cacheRead: 0,
  cacheWrite: 0
};
var VOLCENGINE_AICC_MODEL_CATALOG = [
  {
    id: "doubao-seed-2.0-pro",
    name: "Doubao Seed 2.0 Pro (AICC)",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 256e3,
    maxTokens: 8192
  },
  {
    id: "doubao-seed-2.0-lite",
    name: "Doubao Seed 2.0 Lite (AICC)",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 256e3,
    maxTokens: 8192
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro (AICC)",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1e6,
    maxTokens: 8192
  },
  {
    id: "glm-5.1",
    name: "GLM 5.1 (AICC)",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 2e5,
    maxTokens: 8192
  },
  {
    id: "doubao-seed-2.0-lite-0428",
    name: "Doubao Seed 2.0 Lite 0428 (AICC)",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 256e3,
    maxTokens: 8192
  },
  {
    id: "glm-4.7",
    name: "GLM 4.7 (AICC)",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 2e5,
    maxTokens: 8192
  }
];
function buildVolcengineAiccModelDefinition(entry, cost) {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input],
    cost,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens
  };
}
function buildAiccModelDefinition(entry) {
  return buildVolcengineAiccModelDefinition(entry, VOLCENGINE_AICC_DEFAULT_COST);
}

// src/volcengine-aicc/src/provider-catalog.ts
function buildVolcengineAiccProvider() {
  return {
    baseUrl: VOLCENGINE_AICC_BASE_URL,
    auth: "api-key",
    api: "openai-completions",
    models: VOLCENGINE_AICC_MODEL_CATALOG.map(buildAiccModelDefinition)
  };
}

// src/volcengine-aicc/provider-discovery.ts
var volcengineAiccProviderDiscovery = {
  id: "volcengine-aicc",
  label: "Volcengine AICC",
  docsPath: "/concepts/model-providers#volcengine-aicc",
  auth: [],
  staticCatalog: {
    order: "simple",
    run: async () => ({
      provider: buildVolcengineAiccProvider()
    })
  }
};
var provider_discovery_default = volcengineAiccProviderDiscovery;
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  volcengineAiccProviderDiscovery
});
