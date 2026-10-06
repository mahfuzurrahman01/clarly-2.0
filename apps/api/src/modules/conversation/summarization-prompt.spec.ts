import { buildSummarizationPrompt } from './summarization-prompt';

describe('buildSummarizationPrompt()', () => {
  it('notes there is no existing summary on the first summarization', () => {
    const messages = buildSummarizationPrompt(null, [
      { role: 'user', content: 'Hi, my order is late.' },
    ]);

    expect(messages[1]?.content).toContain('none yet');
  });

  it('includes the prior summary when one exists', () => {
    const messages = buildSummarizationPrompt(
      'Customer asked about shipping.',
      [{ role: 'assistant', content: 'Your order ships in 3-5 days.' }],
    );

    expect(messages[1]?.content).toContain('Customer asked about shipping.');
  });

  it('renders each message with a role label, in order', () => {
    const messages = buildSummarizationPrompt(null, [
      { role: 'user', content: 'Where is my order?' },
      { role: 'assistant', content: 'Let me check.' },
    ]);

    expect(messages[1]?.content).toContain('Customer: Where is my order?');
    expect(messages[1]?.content).toContain('Agent: Let me check.');
    expect(messages[1]?.content.indexOf('Customer:')).toBeLessThan(
      messages[1].content.indexOf('Agent:'),
    );
  });

  it('puts the instruction in a system message', () => {
    const messages = buildSummarizationPrompt(null, []);

    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('running summary');
  });
});
