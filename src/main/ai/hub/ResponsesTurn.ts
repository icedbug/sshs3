/** A stateless Responses turn. Items are retained in memory for the next model call. */
type Item = Record<string, unknown>;
const object = (value: unknown): value is Item => typeof value === "object" && value !== null && !Array.isArray(value);

/** The stream ended without the event that ends an answer: the connection was lost on the way. */
export class StreamEndedEarlyError extends Error {
  constructor() {
    super("The model connection ended before the response finished.");
    this.name = "StreamEndedEarlyError";
  }
}

export class ResponsesTurn {
  private readonly byIndex = new Map<number, Item>();
  private complete = false;
  private canonical?: Item[];
  text = "";
  /** The answer stopped at the output limit. What came is kept: the run asks the model to go on. */
  cut = false;

  constructor(
    private readonly onText: (text: string) => void,
    private readonly onUsage: (usage: Item) => void,
  ) {}

  accept(data: string): void {
    if (data === "[DONE]") return;
    const event: unknown = JSON.parse(data);
    if (!object(event)) throw new Error("The model sent an invalid response event.");
    const response = object(event.response) ? event.response : undefined;
    if (response && object(response.usage)) this.onUsage(response.usage);
    const details = response?.incomplete_details;
    if (event.type === "response.incomplete" && object(details) && details.reason === "max_output_tokens") {
      this.cut = true;
      this.complete = true;
      if (response && Array.isArray(response.output)) this.canonical = response.output.filter(object);
      return;
    }
    if (event.type === "error" || event.type === "response.failed" || event.type === "response.incomplete") {
      const error = object(event.error) ? event.error : response?.error;
      const reason = object(error) ? error.message : object(details) ? details.reason : event.message;
      throw new Error(typeof reason === "string" ? reason : "The model did not finish its response.");
    }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      this.text += event.delta;
      this.onText(event.delta);
    } else if (event.type === "response.output_item.done" && object(event.item)) {
      const index = typeof event.output_index === "number" ? event.output_index : this.byIndex.size;
      this.byIndex.set(index, event.item);
    } else if (event.type === "response.completed") {
      if (response?.status && response.status !== "completed") throw new Error("The model did not finish its response.");
      this.complete = true;
      if (response && Array.isArray(response.output) && response.output.length) {
        this.canonical = response.output.filter(object);
      }
    }
  }

  /**
   * The turn's items and tool calls. For a turn cut at the output limit: only the text that came,
   * as one assistant message, and no call (a call that was being written is incomplete);
   * `cutInCall` says one was being written.
   */
  finish(): { items: Item[]; calls: Array<{ id: string; name: string; argumentsJson: string }>; cutInCall?: boolean } {
    if (!this.complete) throw new StreamEndedEarlyError();
    const items = this.canonical ?? [...this.byIndex].sort(([a], [b]) => a - b).map(([, item]) => item);
    const messages = items.filter((item) => item.type === "message");
    const parts: unknown[] = messages.flatMap((item) => Array.isArray(item.content) ? item.content : []);
    if (parts.some((part) => object(part) && part.type === "refusal")) throw new Error("The model declined this request.");
    const finalText = parts
      .flatMap((part: unknown) => object(part) && typeof part.text === "string" ? [part.text] : []).join("");
    if (finalText) {
      if (finalText.startsWith(this.text)) this.onText(finalText.slice(this.text.length));
      this.text = finalText;
    }
    if (this.cut)
      return {
        items: this.text ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: this.text }] }] : [],
        calls: [],
        cutInCall: items.some((item) => item.type === "function_call"),
      };
    if (!messages.length && this.text) {
      items.unshift({ type: "message", role: "assistant", content: [{ type: "output_text", text: this.text }] });
    }
    const calls = items.filter((item) => item.type === "function_call").map((item) => {
      if (typeof item.call_id !== "string" || !item.call_id || typeof item.name !== "string" || !item.name || typeof item.arguments !== "string") {
        throw new Error("The model sent an incomplete tool call.");
      }
      return { id: item.call_id, name: item.name, argumentsJson: item.arguments };
    });
    if (!calls.length && !this.text.trim()) throw new Error("The model finished without an answer.");
    return { items, calls };
  }
}
