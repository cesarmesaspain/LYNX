import { runDoctor } from '../../install/doctor.js';

export async function cmdDoctor(): Promise<void> {
  await runDoctor();
}
