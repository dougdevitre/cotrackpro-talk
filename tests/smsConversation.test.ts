/**
 * tests/smsConversation.test.ts — Conversational inbound SMS.
 *
 * Covers the pure helpers (routing, crisis screen, reply shaping) and the
 * stateful reply path with a stubbed completer, so nothing here touches
 * Anthropic or the network. The KV store is swapped for the in-memory
 * fake per test, which is what backs thread memory.
 */

import "./helpers/setupEnvHub.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  CRISIS_RESOURCE_LINE,
  MAX_THREAD_TURNS,
  SMS_FALLBACK_REPLY,
  _setSmsCompleterForTests,
  buildSmsSystemPrompt,
  clearThread,
  detectCrisis,
  ensureCrisisResources,
  generateSmsReply,
  isHubCommand,
  loadThread,
  saveThread,
  shapeForSms,
  type SmsCompleter,
} from "../src/core/smsConversation.js";
import { OPT_OUT_FOOTER } from "../src/core/consent.js";
import {
  _resetKvForTests,
  _setKvForTests,
  _MemoryKvForTests as MemoryKv,
} from "../src/services/kv.js";

/** A completer that always returns `text`, recording what it was asked. */
function stubCompleter(
  text: string,
  seen?: { system?: string; messages?: { role: string; content: string }[] }[],
): SmsCompleter {
  return async ({ system, messages }) => {
    seen?.push({ system, messages: messages.map((m) => ({ ...m })) });
    return { text, inputTokens: 10, outputTokens: 5 };
  };
}

beforeEach(() => _setKvForTests(new MemoryKv()));
afterEach(() => {
  _setSmsCompleterForTests(null);
  _resetKvForTests();
});

describe("isHubCommand", () => {
  it("routes the hub's structured commands to the hub", () => {
    for (const cmd of ["CONFIRM", "snooze", "Deadlines", "LOG today", "resources.", "SAFE"]) {
      assert.equal(isHubCommand(cmd), true, `${cmd} should route to the hub`);
    }
  });

  it("treats free text as conversational", () => {
    const freeText = [
      "he showed up two hours late again",
      "what should I write down?",
      "logging in isn't working",
      "yes",
      "hi",
    ];
    for (const t of freeText) {
      assert.equal(isHubCommand(t), false, `"${t}" should be conversational`);
    }
  });

  it("handles empty and whitespace bodies", () => {
    assert.equal(isHubCommand(undefined), false);
    assert.equal(isHubCommand(""), false);
    assert.equal(isHubCommand("   "), false);
  });
});

describe("detectCrisis", () => {
  it("flags active-crisis language", () => {
    const crisis = [
      "I want to kill myself",
      "I've been thinking about suicide",
      "he is hitting her right now",
      "he has a gun in the house",
      "I'm not safe right now",
    ];
    for (const t of crisis) assert.equal(detectCrisis(t), true, `"${t}" should flag`);
  });

  it("does not flag ordinary co-parenting messages", () => {
    const ordinary = [
      "he was two hours late for the exchange",
      "can you help me write down what happened yesterday",
      "the school called about a missed pickup",
    ];
    for (const t of ordinary) assert.equal(detectCrisis(t), false, `"${t}" should not flag`);
  });
});

describe("ensureCrisisResources", () => {
  it("appends the resource line when the numbers are missing", () => {
    const out = ensureCrisisResources("That sounds frightening.");
    assert.ok(out.includes(CRISIS_RESOURCE_LINE));
  });

  it("does not duplicate resources the reply already carries", () => {
    const reply = "Call 911 if you're in danger right now, or reach 988 anytime.";
    assert.equal(ensureCrisisResources(reply), reply);
  });
});

describe("shapeForSms", () => {
  it("strips markdown the SMS channel can't render", () => {
    const out = shapeForSms("**Here** is a _plan_:\n- one\n- two\n1. three");
    assert.ok(!out.includes("*"));
    assert.ok(!out.includes("_"));
    assert.ok(!/^\s*[-•]/m.test(out));
    assert.ok(out.includes("one"));
  });

  it("leaves a short plain reply untouched", () => {
    const text = "That sounds hard. Want me to help you write it down?";
    assert.equal(shapeForSms(text), text);
  });

  it("truncates at a sentence boundary when one is available", () => {
    const sentence = "This is a complete sentence about documentation. ";
    const out = shapeForSms(sentence.repeat(20), 200);
    assert.ok(out.length <= 200);
    assert.ok(out.endsWith("."), `expected a sentence end, got: ${out.slice(-40)}`);
  });

  it("hard-cuts with an ellipsis when there is no usable boundary", () => {
    const out = shapeForSms("x".repeat(500), 100);
    assert.equal(out.length, 100);
    assert.ok(out.endsWith("…"));
  });
});

describe("buildSmsSystemPrompt", () => {
  it("layers SMS channel rules over the shared role persona", () => {
    const kid = buildSmsSystemPrompt("kid_teen");
    assert.ok(kid.includes("SMS"), "should carry the SMS channel rules");
    assert.ok(kid.includes("Child or teenager"), "should carry the role persona");
  });

  it("falls back to the parent persona for an unknown role", () => {
    const unknown = buildSmsSystemPrompt("not_a_role");
    assert.ok(unknown.includes("Parent or self-represented party"));
  });
});

describe("thread memory", () => {
  it("round-trips turns and trims to the cap", async () => {
    const phone = "+15551230001";
    const many = Array.from({ length: MAX_THREAD_TURNS + 6 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `turn ${i}`,
    }));
    await saveThread(phone, many);

    const loaded = await loadThread(phone);
    assert.ok(loaded.length <= MAX_THREAD_TURNS);
    assert.equal(loaded[0]!.role, "user", "a stored thread must start on a user turn");
    assert.equal(loaded.at(-1)!.content, `turn ${many.length - 1}`);
  });

  it("returns an empty thread for an unknown number", async () => {
    assert.deepEqual(await loadThread("+15559998888"), []);
  });

  it("clearThread drops stored context", async () => {
    const phone = "+15551230002";
    await saveThread(phone, [{ role: "user", content: "hello" }]);
    await clearThread(phone);
    assert.deepEqual(await loadThread(phone), []);
  });
});

describe("generateSmsReply", () => {
  it("answers free text conversationally and footers the first reply only", async () => {
    _setSmsCompleterForTests(stubCompleter("That sounds really hard. Want to write it down?"));
    const phone = "+15551230010";

    const first = await generateSmsReply({ from: phone, body: "he was two hours late again" });
    assert.equal(first.source, "ai");
    assert.equal(first.firstTurn, true);
    assert.ok(first.text.includes("That sounds really hard."));
    assert.ok(first.text.includes(OPT_OUT_FOOTER), "first reply carries the opt-out footer");

    const second = await generateSmsReply({ from: phone, body: "what should I write down?" });
    assert.equal(second.firstTurn, false);
    assert.ok(
      !second.text.includes(OPT_OUT_FOOTER),
      "mid-thread replies don't repeat the footer",
    );
  });

  it("carries prior turns into the next request", async () => {
    const seen: { messages?: { role: string; content: string }[] }[] = [];
    _setSmsCompleterForTests(stubCompleter("Noted.", seen));
    const phone = "+15551230011";

    await generateSmsReply({ from: phone, body: "first message" });
    await generateSmsReply({ from: phone, body: "second message" });

    const secondCall = seen[1]!;
    assert.equal(secondCall.messages!.length, 3, "user, assistant, user");
    assert.equal(secondCall.messages![0]!.content, "first message");
    assert.equal(secondCall.messages![1]!.role, "assistant");
    assert.equal(secondCall.messages![2]!.content, "second message");
  });

  it("passes the role persona through to the prompt", async () => {
    const seen: { system?: string }[] = [];
    _setSmsCompleterForTests(stubCompleter("Okay.", seen));
    await generateSmsReply({ from: "+15551230012", body: "hi", role: "attorney" });
    assert.ok(seen[0]!.system!.includes("CALLER ROLE: Attorney"));
  });

  it("guarantees crisis resources even when the model omits them", async () => {
    _setSmsCompleterForTests(stubCompleter("I hear you. I'm here with you."));
    const result = await generateSmsReply({
      from: "+15551230013",
      body: "I want to kill myself",
    });
    assert.ok(result.text.includes("988"));
    assert.ok(result.text.includes("911"));
  });

  it("falls back to a safe static reply when the model fails", async () => {
    _setSmsCompleterForTests(async () => {
      throw new Error("upstream exploded");
    });
    const result = await generateSmsReply({ from: "+15551230014", body: "are you there?" });
    assert.equal(result.source, "fallback");
    assert.ok(result.text.includes(SMS_FALLBACK_REPLY.slice(0, 40)));
    assert.ok(result.text.includes("988"), "the fallback still carries the safety floor");
  });

  it("falls back when the model returns nothing usable", async () => {
    _setSmsCompleterForTests(stubCompleter("   "));
    const result = await generateSmsReply({ from: "+15551230015", body: "hello?" });
    assert.equal(result.source, "fallback");
  });

  it("caps a runaway generation at the reply budget", async () => {
    _setSmsCompleterForTests(stubCompleter("Sentence about documentation. ".repeat(200)));
    const result = await generateSmsReply({ from: "+15551230016", body: "tell me everything" });
    // Budget + the first-turn footer, nothing like the 6000 chars generated.
    assert.ok(
      result.text.length < 700,
      `reply should be capped, got ${result.text.length} chars`,
    );
  });

  it("stores the shaped reply, not the raw completion", async () => {
    _setSmsCompleterForTests(stubCompleter("**Bold** advice here."));
    const phone = "+15551230017";
    await generateSmsReply({ from: phone, body: "hi" });
    const thread = await loadThread(phone);
    const assistantTurn = thread.find((t) => t.role === "assistant")!;
    assert.ok(!assistantTurn.content.includes("**"), "stored turn is the shaped text");
  });
});
