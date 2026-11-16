import type { StartedTestContainer } from 'testcontainers';
import { GenericContainer, Wait } from 'testcontainers';
import type { TestProject } from 'vitest/node';

// Pinned: Dovecot 2.4.5 is the version these tests were written against.
const DOVECOT_IMAGE = 'dovecot/dovecot:2.4.5';
const IMAP_PORT = 31143;
/** The image's static passdb accepts any user name with this password. */
export const DOVECOT_PASSWORD = 'test';

let container: StartedTestContainer | undefined;

export async function setup(project: TestProject): Promise<void> {
  container = await new GenericContainer(DOVECOT_IMAGE)
    .withEnvironment({ USER_PASSWORD: DOVECOT_PASSWORD })
    .withExposedPorts(IMAP_PORT)
    .withWaitStrategy(Wait.forLogMessage(/starting up/))
    .withStartupTimeout(60_000)
    .start();
  project.provide('dovecotHost', container.getHost());
  project.provide('dovecotImapPort', container.getMappedPort(IMAP_PORT));
}

export async function teardown(): Promise<void> {
  await container?.stop();
}

declare module 'vitest' {
  export interface ProvidedContext {
    dovecotHost: string;
    dovecotImapPort: number;
  }
}
