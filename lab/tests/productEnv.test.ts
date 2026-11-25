import { describe, expect, it } from 'vitest';
import { productEnv } from '../src/product';

describe("the product's environment", () => {
  it("never holds the lab's model keys or its way out to the internet", () => {
    const env = productEnv(
      { PATH: '/usr/bin', HOME: '/root', NODE_USE_ENV_PROXY: '1', LAB_ANTHROPIC_API_KEY: 'k1', ANTHROPIC_API_KEY: 'k2', ANTHROPIC_AUTH_TOKEN: 'k3', OPENAI_API_KEY: 'k4' },
      { SSHS3_DATA_DIR: '/data' },
    );
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/root', SSHS3_DATA_DIR: '/data' });
  });
});
