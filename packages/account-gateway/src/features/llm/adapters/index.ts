import type { ModelProtocol } from "../application/index.js";
import { encodeResponsesRequest } from "./responses-request.js";
import { createResponsesDecoder } from "./responses-stream.js";

/** All qualified gateway profiles currently speak OpenAI Responses. */
export const openAIResponses: ModelProtocol = Object.freeze({
  encode: encodeResponsesRequest,
  decoder: createResponsesDecoder,
});
export { LlmSchemaError, prepareStrictJsonSchema } from "./strict-json-schema.js";
export type { StrictJsonSchema } from "./strict-json-schema.js";
