import { describe, expect, it } from 'vitest';
import { pullWithMirrors } from '../src/lab';

describe('pulling an image the lab is built from', () => {
  it('takes a mirror when Docker Hub refuses, and names the image as the Dockerfile does', async () => {
    const ran: string[] = [];
    const docker = async (args: string[]) => {
      ran.push(args.join(' '));
      return { code: args[1] === 'ubuntu:24.04' && args[0] === 'pull' ? 1 : 0, stdout: '', stderr: args[0] === 'pull' && args[1] === 'ubuntu:24.04' ? 'toomanyrequests' : '' };
    };
    await pullWithMirrors('ubuntu:24.04', ['mirror.gcr.io/library/ubuntu:24.04'], docker);
    expect(ran).toEqual(['pull ubuntu:24.04', 'pull mirror.gcr.io/library/ubuntu:24.04', 'tag mirror.gcr.io/library/ubuntu:24.04 ubuntu:24.04']);
  });

  it('says what was tried when nothing answers', async () => {
    const docker = async () => ({ code: 1, stdout: '', stderr: 'toomanyrequests: You have reached your pull rate limit.' });
    await expect(pullWithMirrors('ubuntu:24.04', ['mirror.gcr.io/library/ubuntu:24.04'], docker)).rejects.toThrow(
      'Could not pull ubuntu:24.04 (tried mirror.gcr.io/library/ubuntu:24.04 too): toomanyrequests: You have reached your pull rate limit.',
    );
  });
});
