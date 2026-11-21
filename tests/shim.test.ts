import { describe, expect, it, vi } from 'vitest';
import { decodeGatewayEvent, RobinPartFilter, toGeminiRequest, toRobinRequest, toRpcRequest, ToolCallStream, type GeminiRequest } from '../src/shim.ts';

describe('Gemini request adapters', () => {
  const schema = { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false };
  const request: GeminiRequest = {
    model: 'gemini-custom', systemInstruction: { parts: [{ text: 'Use the document.' }] },
    tools: [{ functionDeclarations: [{ name: 'lookup', description: 'Find a passage', parametersJsonSchema: schema }] }],
    contents: [
      { role: 'user', parts: [{ text: 'First' }, { inlineData: { mimeType: 'application/pdf', data: 'YWJj' } }] },
      { role: 'model', parts: [{ text: 'Checking' }, { functionCall: { name: 'lookup', id: 'call-1', args: { q: 'term' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'lookup', id: 'call-1', response: { match: 'found' } } }, { text: 'Next' }] },
    ],
  };

  it('replays all roles and tool history as a single session script and replaces attachment bytes', async () => {
    const original = structuredClone(request);
    const upload = vi.fn(async (blob: Blob, mime: string) => {
      expect(mime).toBe('application/pdf');
      expect(await blob.text()).toBe('abc');
      return 'file-1';
    });
    const body = await toRpcRequest(request, upload);
    expect(body).toMatchObject({
      model: 'gemini-custom', temporary_chat: true, stream: true, script: {
        system: [{ type: 'text', text: 'Use the document.' }],
        tools: [{ name: 'lookup', description: 'Find a passage', parameters: schema }],
        turns: [
          { role: 'user', parts: [{ type: 'text', text: 'First' }, { type: 'attachment', id: 'file-1', mimeType: 'application/pdf' }] },
          { role: 'model', parts: [{ type: 'text', text: 'Checking' }, { type: 'function_call', call: { name: 'lookup', id: 'call-1', args: { q: 'term' } } }] },
          { role: 'user', parts: [{ type: 'function_response', result: { name: 'lookup', id: 'call-1', response: { match: 'found' } } }, { type: 'text', text: 'Next' }] },
        ],
      },
    });
    expect(body.script.toolCallFormat).toContain('<tool_call>');
    expect(JSON.stringify(body)).not.toContain('YWJj');
    expect(request).toEqual(original);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('preserves native inlineData unless a gateway upload hook returns a reference', async () => {
    expect(await toGeminiRequest(request)).toMatchObject({ contents: request.contents, temporary_chat: true });
    expect(await toGeminiRequest(request, async () => 'files/ref', false)).toMatchObject({
      contents: [{ parts: [{ text: 'First' }, { fileData: { fileUri: 'files/ref', mimeType: 'application/pdf' } }] }, ...request.contents.slice(1)],
      temporary_chat: false,
    });
    await expect(toRpcRequest(request)).rejects.toThrow('upload');
    await expect(toRpcRequest(request, async () => '')).rejects.toThrow('reference ID');
  });

  it('encodes RobinService StreamGenerate query payload and decodes modelResponses', async () => {
    const simple: GeminiRequest = { model: 'gemini-2.5-pro', contents: [{ role: 'user', parts: [{ text: 'What is 9*7?' }] }] };
    expect(await toRobinRequest(simple)).toEqual({ query: { text: 'What is 9*7?' } });

    const withTools = await toRobinRequest(request, async () => 'att-1');
    expect(withTools.query.text).toContain('<system_instruction>');
    expect(withTools.query.text).toContain('<available_tools>');
    expect(withTools.query.text).toContain('<tool_protocol>');
    expect(withTools.query.text).toContain('<tool_call>');
    expect(withTools.query.text).toContain('[Caller Tool Result]');
    expect(withTools.query.attachments).toEqual([{ id: 'att-1', mimeType: 'application/pdf' }]);

    const event = decodeGatewayEvent({
      conversationId: 'c_1234567890abcdef',
      modelResponses: [{
        responseId: 'rc_abc',
        modelAttributionName: '3.5 Flash-Lite',
        textResponse: { text: '63' },
      }],
    });
    expect(event).toMatchObject({
      conversationId: 'c_1234567890abcdef',
      responseId: 'rc_abc',
      modelVersion: '3.5 Flash-Lite',
      finishReason: 'STOP',
      parts: [{ text: '63' }],
    });
  });
});

describe('streamed tool calls', () => {
  it('emits text immediately and parses tags split at every character', () => {
    const parser = new ToolCallStream();
    const args = { code: 'line 1\n```js\nconst x = "literal </tool_call>";\n```', nested: [{ slash: '\\', quote: '"', object: { a: true } }] };
    const call = { name: 'run', args };
    expect(parser.feed('ordinary <to')).toEqual([{ text: 'ordinary ' }]);
    const parts = Array.from(`ol_call>\n${JSON.stringify(call, null, 2)}\n</tool_call>tail`).flatMap(char => parser.feed(char));
    expect(parts.filter(part => part.functionCall)).toEqual([{ functionCall: call }]);
    expect(parts.flatMap(part => part.text ?? []).join('')).toBe('tail');
    expect(parser.finish()).toEqual([]);
  });

  it('preserves order for multiple calls and text in the same frame', () => {
    const parser = new ToolCallStream();
    const call = '<tool_call>{"name":"x","args":{}}</tool_call>';
    expect(parser.feed(`a${call}b${call}c`)).toEqual([
      { text: 'a' }, { functionCall: { name: 'x', args: {} } }, { text: 'b' },
      { functionCall: { name: 'x', args: {} } }, { text: 'c' },
    ]);
  });

  it('returns invalid or incomplete markup intact without executing it', () => {
    const parser = new ToolCallStream();
    expect(parser.feed('<tool_call>{"name":"x","args":[]}</tool_call>')).toEqual([{ text: '<tool_call>{"name":"x","args":[]}</tool_call>' }]);
    expect(parser.feed('<tool_call>{"name":"x","args":{"a":1</tool_call>')).toEqual([{ text: '<tool_call>{"name":"x","args":{"a":1</tool_call>' }]);
    expect(parser.feed('keep <tool_')).toEqual([{ text: 'keep ' }]);
    expect(parser.finish()).toEqual([{ text: '<tool_' }]);
    expect(parser.feed('<tool_call>{"name":')).toEqual([]);
    expect(parser.finish()).toEqual([{ text: '<tool_call>{"name":' }]);
  });

  it('repairs unescaped LaTeX, hex, invalid \\u escapes, and raw newlines inside closed tool_call JSON strings', () => {
    const parser = new ToolCallStream();

    // Case 1: LaTeX commands with single backslashes (\circ, \Leftrightarrow, \Rightarrow, \sqrt, \usepackage) + valid \n and \u4f60
    const latexRaw = String.raw`<tool_call>{"name":"wechat_send","args":{"text":"第一行\n1. 5^(\circ)C 和 \Leftrightarrow / \Rightarrow / \sqrt{LC} / \usepackage / \u4f60"}}</tool_call>`;
    const latexParts = parser.feed(latexRaw);
    expect(latexParts).toEqual([{
      functionCall: {
        name: 'wechat_send',
        args: {
          text: '第一行\n1. 5^(\\circ)C 和 \\Leftrightarrow / \\Rightarrow / \\sqrt{LC} / \\usepackage / 你',
        },
      },
    }]);

    // Case 2: Hex byte literals (\x02, \xff\xff) + already-escaped \\x03 preserved without double-escaping
    const hexRaw = String.raw`<tool_call>{"name":"wechat_send","args":{"text":"缺 \x02 头或多了 \xff\xff 尾，已转义 \\x03 保持不变"}}</tool_call>`;
    const hexParts = parser.feed(hexRaw);
    expect(hexParts).toEqual([{
      functionCall: {
        name: 'wechat_send',
        args: {
          text: '缺 \\x02 头或多了 \\xff\\xff 尾，已转义 \\x03 保持不变',
        },
      },
    }]);

    // Case 3: Raw unescaped newline inside JSON string value
    const rawNewline = '<tool_call>{"name":"pet_say","args":{"script":"第一行\n第二行"}}</tool_call>';
    expect(parser.feed(rawNewline)).toEqual([{
      functionCall: {
        name: 'pet_say',
        args: { script: '第一行\n第二行' },
      },
    }]);
  });

  it('accepts arguments alias in tool_call JSON and truncates Robin hallucinated follow-up turns & echoed stop cues', async () => {
    const run = (raw: string) => {
      const parser = new ToolCallStream();
      const filter = new RobinPartFilter();
      const parts = [];
      for (const ch of raw) parts.push(...filter.feed(parser.feed(ch)));
      parts.push(...filter.feed(parser.finish()), ...filter.finish());
      return parts;
    };

    // Hallucinated [User N] continuation truncates both fake prose and hallucinated next-turn tool calls.
    const leaked1 = '<tool_call>{"name":"pet_say","args":{"script":"好嘞~"}}</tool_call>\n\n\n[User 0003]\n好嘞~那俺就乖乖守着你！\n<tool_call>{"name":"end_turn","arguments":{}}</tool_call>';
    expect(run(leaked1)).toEqual([
      { functionCall: { name: 'pet_say', args: { script: '好嘞~' } } },
    ]);

    // Echoed protocol stop slogan (doubled) + hallucinated second turn after read_file.
    const round3Leak = [
      '<tool_call>{"name":"read_file","id":"call_0_read_img","args":{"path":"a.jpg"}}</tool_call>',
      'STOP immediately and wait for the caller to return the real tool results. STOP immediately and wait for the caller to return the real tool results.',
      '<tool_call>{"name":"wechat_send","id":"call_0_wx_img","args":{"text":"看不见"}}</tool_call>',
      '<tool_call>{"name":"pet_say","id":"call_1_pet_img","args":{"script":"看不见"}}</tool_call>',
      '<tool_call>{"name":"end_turn","id":"call_2_end","args":{}}</tool_call>',
    ].join('\n');
    expect(run(round3Leak)).toEqual([
      { functionCall: { name: 'read_file', id: 'call_0_read_img', args: { path: 'a.jpg' } } },
    ]);

    // Hallucinated Turn 2 signaled purely by call_0_ ordinal reset with no text marker between calls.
    const resetOrdinal = '<tool_call>{"name":"read_file","id":"call_0_a","args":{"path":"a.txt"}}</tool_call>\n<tool_call>{"name":"wechat_send","id":"call_0_b","args":{"text":"hi"}}</tool_call>';
    expect(run(resetOrdinal)).toEqual([
      { functionCall: { name: 'read_file', id: 'call_0_a', args: { path: 'a.txt' } } },
    ]);

    // Legitimate parallel calls in the same turn with monotonic call ordinals are all preserved.
    const validParallel = [
      '<tool_call>{"name":"wechat_send","id":"call_0_wx","args":{"text":"路上小心"}}</tool_call>',
      '<tool_call>{"name":"pet_say","id":"call_1_pet","args":{"script":"路上小心"}}</tool_call>',
      '<tool_call>{"name":"end_turn","id":"call_2_end","arguments":{}}</tool_call>',
    ].join('\n');
    expect(run(validParallel)).toEqual([
      { functionCall: { name: 'wechat_send', id: 'call_0_wx', args: { text: '路上小心' } } },
      { functionCall: { name: 'pet_say', id: 'call_1_pet', args: { script: '路上小心' } } },
      { functionCall: { name: 'end_turn', id: 'call_2_end', args: {} } },
    ]);

    const normalProse = run('你好！这是一段正常回复，没有工具调用。');
    expect(normalProse.map(p => p.text).join('')).toBe('你好！这是一段正常回复，没有工具调用。');

    // Legitimate English sentence starting with "Stop immediately" is not falsely stripped.
    const normalStop = run('Stop immediately if you smell smoke and call 911.');
    expect(normalStop.map(p => p.text).join('')).toBe('Stop immediately if you smell smoke and call 911.');

    const proseBeforeCall = run('我帮你查一下\n<tool_call>{"name":"search","args":{"q":"hi"}}</tool_call>\n\n');
    expect(proseBeforeCall.filter(p => p.functionCall)).toEqual([{ functionCall: { name: 'search', args: { q: 'hi' } } }]);
    expect(proseBeforeCall.filter(p => p.text).map(p => p.text).join('')).toBe('我帮你查一下');

    // Historical leaked protocol stop echoes are stripped before replaying history back to Robin.
    const replayed = await toRobinRequest({
      model: 'gemini-4-neon',
      tools: [{ functionDeclarations: [{ name: 'end_turn', parametersJsonSchema: { type: 'object' } }] }],
      contents: [
        { role: 'user', parts: [{ text: 'hello' }] },
        {
          role: 'model',
          parts: [
            { text: 'STOP immediately and wait for the caller to return the real tool results. STOP immediately and wait for the caller to return the real tool results.' },
            { functionCall: { name: 'end_turn', id: 'call_0_end', args: {} } },
          ],
        },
        { role: 'user', parts: [{ text: 'next' }] },
      ],
    });
    expect(replayed.query.text).not.toContain('STOP immediately');
  });

  it('strips historical thought traces from Robin plain-text replays while preserving replies and tool calls', async () => {
    const req: GeminiRequest = {
      model: 'gemini-4-hydrogen',
      contents: [
        { role: 'user', parts: [{ text: 'First question' }] },
        {
          role: 'model',
          parts: [
            { text: 'Long private chain of thought that should not be re-sent', thought: true },
            { text: 'Short final answer' },
          ],
        },
        { role: 'user', parts: [{ text: 'Tool step' }] },
        {
          role: 'model',
          parts: [{ text: 'Thought-only step with no visible text', thought: true }],
        },
        {
          role: 'model',
          parts: [
            { text: 'Secret planning before tool call', thought: true },
            { functionCall: { name: 'lookup', id: 'c1', args: { q: 'hi' } } },
          ],
        },
        { role: 'user', parts: [{ text: 'Latest question' }] },
      ],
    };
    const robin = await toRobinRequest(req);
    expect(robin.query.text).not.toContain('<thought>');
    expect(robin.query.text).not.toContain('Long private chain of thought');
    expect(robin.query.text).not.toContain('Thought-only step');
    expect(robin.query.text).not.toContain('Secret planning');
    expect(robin.query.text).toContain('Short final answer');
    expect(robin.query.text).toContain('<tool_call>{"name":"lookup","id":"c1","args":{"q":"hi"}}</tool_call>');
    expect(robin.query.text).toContain('Latest question');
    // Thought-only model turn does not leave an empty [Assistant] header.
    expect(robin.query.text).not.toMatch(/\[Assistant\]\s*\n\s*\[Assistant\]/);

    // Native Gemini REST & generic RPC adapters remain unaffected.
    const nativeBody = await toGeminiRequest(req) as { contents: GeminiRequest['contents'] };
    expect(nativeBody.contents[1].parts[0]).toEqual({ text: 'Long private chain of thought that should not be re-sent', thought: true });
    const rpcBody = await toRpcRequest(req);
    expect(rpcBody.script.turns[1].parts[0]).toEqual({ type: 'text', text: 'Long private chain of thought that should not be re-sent', thought: true });
  });

  it('losslessly prunes JSON Schema boilerplate in Robin tool declarations without dropping semantics or parameter names', async () => {
    const req: GeminiRequest = {
      model: 'gemini-4-hydrogen',
      tools: [{
        functionDeclarations: [
          {
            name: 'pet_say',
            description: 'Speak aloud',
            parametersJsonSchema: {
              $schema: 'http://json-schema.org/draft-07/schema#',
              $id: 'pet_say_schema',
              $comment: 'auto generated',
              title: 'pet_say',
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string', title: 'title', description: 'Dialog heading' },
                mood: { type: 'string', enum: ['happy', 'calm'], description: '   ' },
                extra: { type: 'object', additionalProperties: { type: 'string', $comment: 'val' } },
                tags: { type: 'array', items: { type: 'string', additionalProperties: false } },
                fallbackLabel: { type: 'string', title: 'Display label when no description' },
              },
              required: ['title'],
            },
          },
          {
            name: 'end_turn',
            description: '   ',
            parametersJsonSchema: {
              $schema: 'http://json-schema.org/draft-07/schema#',
              type: 'object',
              properties: {},
              required: [],
              additionalProperties: false,
            },
          },
        ],
      }],
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    };

    const robin = await toRobinRequest(req);
    const match = /<available_tools>\n([\s\S]*?)\n<\/available_tools>/.exec(robin.query.text);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![1]) as unknown[];
    expect(parsed).toEqual([
      {
        name: 'pet_say',
        description: 'Speak aloud',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Dialog heading' },
            mood: { type: 'string', enum: ['happy', 'calm'] },
            extra: { type: 'object', additionalProperties: { type: 'string' } },
            tags: { type: 'array', items: { type: 'string' } },
            fallbackLabel: { type: 'string', title: 'Display label when no description' },
          },
          required: ['title'],
        },
      },
      {
        name: 'end_turn',
        parameters: { type: 'object' },
      },
    ]);
  });
});
