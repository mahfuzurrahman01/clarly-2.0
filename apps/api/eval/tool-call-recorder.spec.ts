import {
  ToolCallRecorder,
  instrumentToolExecution,
} from './tool-call-recorder';

describe('ToolCallRecorder executed flag (H3a)', () => {
  it('marks a call that ran as executed', () => {
    const recorder = new ToolCallRecorder();
    recorder.beginTurn();
    recorder.record('lookup_product', { query: 'x' }, { found: true });
    expect(recorder.turnToolCalls()[0].executed).toBe(true);
  });

  it('marks an authorize() refusal as not executed, keeping the error', () => {
    const recorder = new ToolCallRecorder();
    recorder.beginTurn();
    recorder.recordAuthorizeFailure('create_order', new Error('ToolScope'));
    expect(recorder.turnToolCalls()[0]).toMatchObject({
      name: 'create_order',
      executed: false,
      error: 'ToolScope',
    });
  });
});

describe('instrumentToolExecution() (H3a)', () => {
  const ctx = {} as never;

  function setup(authorize: jest.Mock, execute: jest.Mock) {
    const service = { authorize, execute } as never;
    const instrumentation = instrumentToolExecution(service);
    const recorder = new ToolCallRecorder();
    recorder.beginTurn();
    instrumentation.setCurrent(recorder);
    return {
      service: service as unknown as {
        authorize: jest.Mock;
        execute: jest.Mock;
      },
      recorder,
    };
  }

  it('records a refused authorize() as not executed and rethrows', async () => {
    const { service, recorder } = setup(
      jest.fn().mockRejectedValue(new Error('ToolScopeViolation')),
      jest.fn(),
    );
    await expect(service.authorize(ctx, 'create_order', {})).rejects.toThrow(
      'ToolScopeViolation',
    );
    expect(recorder.turnToolCalls()).toHaveLength(1);
    expect(recorder.turnToolCalls()[0].executed).toBe(false);
  });

  it('records an execute() that returned as executed', async () => {
    const { service, recorder } = setup(
      jest.fn(),
      jest.fn().mockResolvedValue({ status: 'confirmed' }),
    );
    await service.execute(ctx, 'create_order', { a: 1 });
    expect(recorder.turnToolCalls()[0]).toMatchObject({
      name: 'create_order',
      executed: true,
      result: { status: 'confirmed' },
    });
  });
});
