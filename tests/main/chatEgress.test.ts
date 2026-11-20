import { describe, expect, it } from 'vitest';
import { describeActiveDataFlow, validateChatEgress } from '../../src/shared/dataDestination';

/**
 * The team chat is a place data goes like any other: an answer can quote terminal output. The data
 * policy says where the agent bot may post.
 */

describe('validateChatEgress', () => {
  it('lets standard send to Slack and to any Mattermost', () => {
    expect(validateChatEgress('standard', 'slack')).toMatchObject({ allowed: true, host: 'slack.com', locality: 'external' });
    expect(validateChatEgress(undefined, 'mattermost', 'https://chat.example.com')).toMatchObject({ allowed: true, locality: 'external' });
  });

  it('"only my network" stops Slack and allows only a Mattermost on this machine or the private network', () => {
    const slack = validateChatEgress('local-only', 'slack');
    expect(slack.allowed).toBe(false);
    expect(slack.errors[0]).toContain('Slack is an outside service');
    expect(validateChatEgress('local-only', 'mattermost', 'https://10.1.2.3')).toMatchObject({ allowed: true, locality: 'private-network' });
    expect(validateChatEgress('local-only', 'mattermost', 'http://127.0.0.1:8065')).toMatchObject({ allowed: true, locality: 'local', warnings: [] });
    const outside = validateChatEgress('local-only', 'mattermost', 'https://chat.example.com');
    expect(outside.allowed).toBe(false);
    expect(outside.errors[0]).toContain('chat.example.com is outside it');
  });

  it('"only EU" stops Slack and allows Mattermost only on an EU listed or private host', () => {
    expect(validateChatEgress('eu-pinned', 'slack').errors[0]).toContain('Slack is not one of them');
    expect(validateChatEgress('eu-pinned', 'mattermost', 'https://chat.example.com').allowed).toBe(false);
    expect(validateChatEgress('eu-pinned', 'mattermost', 'https://chat.corp.eu', { euAllowedHosts: ['*.corp.eu'] })).toMatchObject({ allowed: true, locality: 'eu' });
    expect(validateChatEgress('eu-pinned', 'mattermost', 'https://192.168.1.20').allowed).toBe(true);
  });

  it('needs a Mattermost address, and notes one reached without https', () => {
    expect(validateChatEgress('standard', 'mattermost').allowed).toBe(false);
    expect(validateChatEgress('standard', 'mattermost', 'ftp://chat.example.com').allowed).toBe(false);
    const plain = validateChatEgress('standard', 'mattermost', 'http://10.0.0.5');
    expect(plain.allowed).toBe(true);
    expect(plain.encryptedInTransit).toBe(false);
    expect(plain.warnings[0]).toContain('without https');
  });
});

describe('describeActiveDataFlow with the team chat', () => {
  const model = { provider: 'openai-compatible' as const, baseUrl: 'http://127.0.0.1:11434/v1', egressPolicy: 'eu-pinned' as const };

  it('stays as it was when the agent bot is not set up', () => {
    expect(describeActiveDataFlow(model).channels).toHaveLength(3);
  });

  it('lists each chat the agent bot posts to, with what the policy says about it', () => {
    const flow = describeActiveDataFlow(model, null, [
      { service: 'slack', enabled: true },
      { service: 'mattermost', baseUrl: 'https://10.0.0.9', enabled: true },
    ]);
    const chat = flow.channels.filter((c) => c.channel === 'team-chat');
    expect(chat).toHaveLength(2);
    expect(chat[0]).toMatchObject({ host: 'slack.com', locality: 'external' });
    expect(chat[0].notes[0]).toContain('Slack is not one of them');
    expect(chat[1]).toMatchObject({ locality: 'private-network', notes: [] });
    expect(flow.subprocessors.map((s) => s.name)).toEqual(['Slack']);
  });
});
