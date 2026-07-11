import { findNearestProject } from '../../discovery/project-scanner.js';

export function cmdDetect(args: string[]): void {
  const targetPath = args[0] || process.cwd();
  const detected = findNearestProject(targetPath);
  if (detected) {
    console.log(`Project: ${detected.name}`);
    console.log(`  Language:  ${detected.language}`);
    if (detected.secondaryLanguages.length > 0) {
      console.log(`  Secondary: ${detected.secondaryLanguages.join(', ')}`);
    }
    if (detected.frameworks.length > 0) {
      console.log(`  Frameworks: ${detected.frameworks.join(', ')}`);
    }
    console.log(`  Root:     ${detected.rootPath}`);
    console.log(`  Markers:  ${detected.markers.join(', ')}`);
    console.log(`  Confidence: ${(detected.confidence * 100).toFixed(0)}%`);
  } else {
    console.log('No project detected.');
  }
}
