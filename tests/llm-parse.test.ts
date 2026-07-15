import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionSchema, type Action } from '../src/gym/actions.js';

/**
 * The model-output parser, tested in isolation.
 *
 * This is the fragile seam of any LLM adapter: models return fenced blocks, bare
 * JSON, prose wrappers, and invalid actions. The rule is lenient framing, strict
 * validation — a malformed action is dropped with a reason, never guessed at, so
 * a hallucinated action can never reach the env.
 *
 * The function under test is duplicated here rather than exported from an
 * examples/ file (examples are not part of the library surface); it is the same
 * logic as examples/llm-policy.ts::parseActions.
 */
function parseActions(text: string): { actions: Action[]; reasoning: string; dropped: string[] } {
  const dropped: string[] = [];
  let obj: unknown;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  // Fenced content wins. Otherwise slice from the first opening bracket to the
  // last closing one — using whichever of { or [ comes first, so a bare
  // top-level array is not silently truncated into its first object.
  let raw: string;
  if (fence) {
    raw = fence[1]!;
  } else {
    const firstObj = text.indexOf('{');
    const firstArr = text.indexOf('[');
    const start =
      firstArr >= 0 && (firstObj < 0 || firstArr < firstObj) ? firstArr : firstObj;
    const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']')) + 1;
    raw = start >= 0 && end > start ? text.slice(start, end) : text;
  }
  try {
    obj = JSON.parse(raw);
  } catch {
    return { actions: [], reasoning: '', dropped: ['response was not valid JSON'] };
  }
  const record = obj as { reasoning?: unknown; actions?: unknown };
  const reasoning = typeof record.reasoning === 'string' ? record.reasoning : '';
  const list = Array.isArray(record.actions) ? record.actions : Array.isArray(obj) ? obj : [];
  const actions: Action[] = [];
  for (const c of list) {
    const parsed = ActionSchema.safeParse(c);
    if (parsed.success) actions.push(parsed.data);
    else dropped.push(`${(c as { type?: string })?.type ?? '?'}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  }
  return { actions, reasoning, dropped };
}

test('parses a fenced json block', () => {
  const r = parseActions('```json\n{"reasoning":"go","actions":[{"type":"no_op"}]}\n```');
  assert.equal(r.actions.length, 1);
  assert.equal(r.reasoning, 'go');
});

test('parses bare json with surrounding prose', () => {
  const r = parseActions('Here is my plan: {"actions":[{"type":"measure_vitals","patient":"pt-1"}]} done.');
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0]!.type, 'measure_vitals');
});

test('parses a bare top-level array', () => {
  const r = parseActions('[{"type":"no_op"}]');
  assert.equal(r.actions.length, 1);
});

test('drops invalid actions with a reason, keeps valid ones', () => {
  const r = parseActions(
    '```json\n{"actions":[{"type":"no_op"},{"type":"triage","patient":"pt-1","esi":9},{"type":"nonsense"}]}\n```',
  );
  assert.equal(r.actions.length, 1, 'only the valid no_op survives');
  assert.equal(r.dropped.length, 2, 'the bad ESI and the unknown type are dropped');
});

test('a hallucinated action type can never reach the env', () => {
  const r = parseActions('{"actions":[{"type":"launch_missiles","patient":"pt-1"}]}');
  assert.equal(r.actions.length, 0);
  assert.equal(r.dropped.length, 1);
});

test('non-JSON garbage yields no actions, not a crash', () => {
  const r = parseActions('I refuse to answer in JSON. The patient in bed 3 needs attention.');
  assert.equal(r.actions.length, 0);
  assert.ok(r.dropped.length > 0);
});

test('empty actions list is valid (let time pass)', () => {
  const r = parseActions('```json\n{"reasoning":"observe","actions":[]}\n```');
  assert.equal(r.actions.length, 0);
  assert.equal(r.dropped.length, 0);
});

test('every parsed action satisfies the env schema', () => {
  // Anything parseActions returns must be directly steppable — no second
  // validation needed at the call site.
  const r = parseActions(
    '```json\n{"actions":[{"type":"order_lab","patient":"pt-1","test":"troponin","priority":"stat","route":"poct"}]}\n```',
  );
  assert.equal(r.actions.length, 1);
  assert.doesNotThrow(() => ActionSchema.parse(r.actions[0]));
});
