import { ZenError } from './store';

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

export function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Wraps a handler so it can just return plain data: the value is serialized as
 * JSON, and failures come back as tool errors instead of transport errors.
 */
export function jsonTool<Args>(handler: (args: Args) => Promise<unknown>) {
  return async (args: Args): Promise<ToolResult> => {
    try {
      return jsonResult(await handler(args));
    } catch (error) {
      if (error instanceof ZenError) return errorResult(error.message);
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  };
}
