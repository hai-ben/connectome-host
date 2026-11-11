/**
 * Live check of PR #641's recovered-thinking guard, through the real
 * LoggingAnthropicAdapter. Run from a checkout of the PR branch:
 *   ANTHROPIC_API_KEY=... bun run live-test-641.ts
 * About 5 tiny calls (max 16 output tokens, thinking off): well under a cent.
 * Set DRY=1 to run against a fake API instead (no key, no cost).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoggingAnthropicAdapter } from './src/logging-adapter.js';
import { recoveredThinkingRefused } from './src/recovered-thinking.js';

const sends: Array<{ model: string; tagged: boolean; stop?: string; category?: string; out?: number }> = [];
const hasTag = (body: string) => body.includes('<recovered_thinking>');
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!url.includes('/v1/messages') || url.includes('count_tokens')) return realFetch(input, init);
  const body = String(init?.body ?? '');
  const parsed = JSON.parse(body);
  const entry: (typeof sends)[number] = { model: parsed.model, tagged: hasTag(body) };
  sends.push(entry);
  if (process.env.DRY) {
    const refuse = entry.tagged && /opus-5|fable/.test(parsed.model);
    const msg = refuse
      ? { id: 'm', type: 'message', role: 'assistant', model: parsed.model, content: [], stop_reason: 'refusal', stop_sequence: null, stop_details: { type: 'refusal', category: 'reasoning_extraction' }, usage: { input_tokens: 20, output_tokens: 0 } }
      : { id: 'm', type: 'message', role: 'assistant', model: parsed.model, content: [{ type: 'text', text: 'Fine, thanks!' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 4 } };
    Object.assign(entry, { stop: msg.stop_reason, category: (msg as any).stop_details?.category, out: msg.usage.output_tokens });
    if (parsed.stream) {
      const ev = (t: string, d: unknown) => `event: ${t}\ndata: ${JSON.stringify(d)}\n\n`;
      let s = ev('message_start', { type: 'message_start', message: { ...msg, content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 0 } } });
      msg.content.forEach((b: any, i: number) => {
        s += ev('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
        s += ev('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: b.text } });
        s += ev('content_block_stop', { type: 'content_block_stop', index: i });
      });
      s += ev('message_delta', { type: 'message_delta', delta: { stop_reason: msg.stop_reason, stop_sequence: null, ...(refuse ? { stop_details: msg.stop_details } : {}) }, usage: { output_tokens: msg.usage.output_tokens } });
      s += ev('message_stop', { type: 'message_stop' });
      return new Response(s, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_dry' } });
    }
    return new Response(JSON.stringify(msg), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_dry' } });
  }
  const res = await realFetch(input, init);
  return res;
}) as typeof fetch;

const key = process.env.DRY ? 'dry-key' : process.env.ANTHROPIC_API_KEY;
if (!key) { console.error('ANTHROPIC_API_KEY is not set'); process.exit(1); }
const dir = mkdtempSync(join(tmpdir(), 'live641-'));
const adapter = new LoggingAnthropicAdapter({ apiKey: key }, join(dir, 'llm.jsonl'), () => ({ enabled: false, budgetTokens: 0 }));

const TAG = '<recovered_thinking>\n\n</recovered_thinking>';
const chat = () => [
  { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  { role: 'assistant', content: [{ type: 'text', text: TAG }, { type: 'text', text: 'Hello!' }] },
  { role: 'user', content: [{ type: 'text', text: 'how are you? (one short sentence)' }] },
];
const req = (model: string) => ({ model, maxTokens: 16, messages: chat() }) as never;
const text = (r: any) => (r?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');

let ok = true;
const check = (label: string, cond: boolean) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) ok = false; };
const step = async (label: string, run: () => Promise<any>, expectSends: boolean[]) => {
  const before = sends.length;
  const r = await run();
  const mine = sends.slice(before);
  console.log(`\n${label}\n  sends: ${mine.map((s) => (s.tagged ? 'with tag' : 'without tag')).join(', ')}\n  final: stop=${r?.stopReason} text=${JSON.stringify(text(r))}`);
  check(`${label}: sends were [${expectSends.map((t) => (t ? 'with' : 'without')).join(', ')}]`, JSON.stringify(mine.map((s) => s.tagged)) === JSON.stringify(expectSends));
  check(`${label}: answered normally`, r?.stopReason !== 'refusal' && text(r).length > 0);
};

const OPUS = process.env.REFUSING_MODEL ?? 'claude-opus-5-5';
const SONNET = process.env.ACCEPTING_MODEL ?? 'claude-sonnet-5-5';
await step(`1. ${OPUS}, stream, first request (expect refusal, then resend without the tag)`, () => adapter.stream(req(OPUS), { onChunk() {} } as never), [true, false]);
check(`${OPUS} is now marked as refusing`, recoveredThinkingRefused(OPUS));
await step(`2. ${OPUS}, complete, second request (expect tag left out from the start)`, () => adapter.complete(req(OPUS)), [false]);
await step(`3. ${SONNET}, stream, control (expect tag kept, no refusal)`, () => adapter.stream(req(SONNET), { onChunk() {} } as never), [true]);
check(`${SONNET} is not marked`, !recoveredThinkingRefused(SONNET));
console.log(`\nTotal API calls: ${sends.length}. Log: ${join(dir, 'llm.jsonl')}`);
console.log(ok ? '\nALL PASS' : '\nSOME CHECKS FAILED');
process.exit(ok ? 0 : 1);
