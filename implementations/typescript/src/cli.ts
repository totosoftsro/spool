#!/usr/bin/env node
/**
 * The `spool` command line.
 *
 * The command set is shared across implementations: `spool lint` in Python
 * behaves identically to `spool lint` here, and the conformance suite checks it.
 * Adding a command to one implementation without the other is a divergence.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parseFixture, serializeFixture } from './fixture.js';
import { digestRequest } from './digest.js';
import { Player } from './player.js';
import { renderMismatch } from './render.js';
import { redactFixture, scanFixture } from './redact.js';
import { HifStructuralError } from './errors.js';
import { bodyBytes } from './body.js';
import { VERSION } from './index.js';
import type { Fixture, HifRequest } from './types.js';

const USAGE = `spool ${VERSION} — portable HTTP fixtures (HIF ${'1.0'})

Usage:
  spool lint <fixture...>            Validate fixtures and report warnings
  spool inspect <fixture>            Summarise a fixture's interactions
  spool digest <fixture>             Print the hif-digest-1 of each request
  spool scan <fixture...>            Report suspected secrets, without changing anything
  spool redact <fixture> [-o out]    Apply redaction rules to an existing fixture
  spool explain <fixture> <request>  Explain why a request does not match
  spool diff <a> <b>                 Compare two fixtures interaction by interaction

Options:
  -o, --output <path>   Write output to a file instead of stdout
      --json            Machine-readable output where supported
      --all             Show every candidate in explain output
      --color           Force ANSI colour
  -h, --help            Show this help
  -v, --version         Show the version

The <request> argument to "explain" is a JSON file or inline JSON of the form:
  { "method": "POST", "url": "https://api.example.com/v1/users",
    "headers": [["content-type","application/json"]],
    "body": { "encoding": "json", "json": { "name": "Ada" } } }

Exit codes:
  0  success
  1  a fixture is invalid, a request does not match, or a diff found changes
  2  usage error
`;

interface Options {
  output?: string;
  json: boolean;
  all: boolean;
  color: boolean;
}

function main(argv: string[]): number {
  const args: string[] = [];
  const options: Options = { json: false, all: false, color: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '-h':
      case '--help':
        process.stdout.write(USAGE);
        return 0;
      case '-v':
      case '--version':
        process.stdout.write(VERSION + '\n');
        return 0;
      case '-o':
      case '--output':
        options.output = argv[++i];
        break;
      case '--json':
        options.json = true;
        break;
      case '--all':
        options.all = true;
        break;
      case '--color':
        options.color = true;
        break;
      default:
        if (arg.startsWith('-')) {
          process.stderr.write(`Unknown option ${arg}\n\n${USAGE}`);
          return 2;
        }
        args.push(arg);
    }
  }

  const command = args.shift();
  if (!command) {
    process.stdout.write(USAGE);
    return 2;
  }

  try {
    switch (command) {
      case 'lint':
        return cmdLint(args, options);
      case 'inspect':
        return cmdInspect(args, options);
      case 'digest':
        return cmdDigest(args, options);
      case 'scan':
        return cmdScan(args, options);
      case 'redact':
        return cmdRedact(args, options);
      case 'explain':
        return cmdExplain(args, options);
      case 'diff':
        return cmdDiff(args, options);
      default:
        process.stderr.write(`Unknown command "${command}"\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    if (err instanceof HifStructuralError) {
      process.stderr.write(`error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

function load(path: string): Fixture {
  const { fixture } = parseFixture(readFileSync(path, 'utf8'), path);
  return fixture;
}

function emit(text: string, options: Options): void {
  if (options.output) writeFileSync(options.output, text);
  else process.stdout.write(text);
}

// ---------------------------------------------------------------------------

function cmdLint(paths: string[], options: Options): number {
  if (paths.length === 0) return usage('lint requires at least one fixture path');
  let failed = false;
  const report: Array<{ file: string; ok: boolean; error?: string; warnings: string[] }> = [];

  for (const path of paths) {
    try {
      const { warnings } = parseFixture(readFileSync(path, 'utf8'), path);
      report.push({ file: path, ok: true, warnings });
    } catch (err) {
      failed = true;
      report.push({ file: path, ok: false, error: (err as Error).message, warnings: [] });
    }
  }

  if (options.json) {
    emit(JSON.stringify(report, null, 2) + '\n', options);
    return failed ? 1 : 0;
  }

  for (const entry of report) {
    if (!entry.ok) {
      process.stderr.write(`✗ ${entry.file}\n  ${entry.error}\n`);
      continue;
    }
    if (entry.warnings.length === 0) {
      process.stdout.write(`✓ ${entry.file}\n`);
    } else {
      process.stdout.write(`✓ ${entry.file} (${entry.warnings.length} warning(s))\n`);
      for (const w of entry.warnings) process.stdout.write(`  ! ${w}\n`);
    }
  }
  return failed ? 1 : 0;
}

function cmdInspect(paths: string[], options: Options): number {
  const path = paths[0];
  if (!path) return usage('inspect requires a fixture path');
  const fixture = load(path);

  if (options.json) {
    emit(JSON.stringify(fixture, null, 2) + '\n', options);
    return 0;
  }

  const lines: string[] = [];
  lines.push(`${path}`);
  lines.push(`  HIF ${fixture.hif}, ${fixture.interactions.length} interaction(s)`);
  if (fixture.meta?.name) lines.push(`  name: ${fixture.meta.name}`);
  if (fixture.meta?.recorder) {
    lines.push(`  recorder: ${fixture.meta.recorder.name ?? '?'} ${fixture.meta.recorder.version ?? ''}`.trimEnd());
  }
  if (fixture.meta?.redaction?.applied) {
    lines.push(`  redaction: applied (${(fixture.meta.redaction.rules ?? []).join(', ')})`);
  } else {
    lines.push('  redaction: not recorded as applied');
  }
  lines.push('');

  fixture.interactions.forEach((it, i) => {
    const ref = it.id ?? `[${i}]`;
    const times = it.replay?.times ?? 1;
    const outcome = it.fault ? `fault:${it.fault.type}` : `${it.response?.status ?? '?'}`;
    const size = it.response?.body ? bodyBytes(it.response.body).length : 0;
    lines.push(`  ${ref}`);
    lines.push(`    ${it.request.method} ${it.request.url}`);
    lines.push(`    -> ${outcome}${size ? `, ${size} byte body` : ''}${times === 1 ? '' : `, plays ${times}`}`);
  });

  emit(lines.join('\n') + '\n', options);
  return 0;
}

function cmdDigest(paths: string[], options: Options): number {
  const path = paths[0];
  if (!path) return usage('digest requires a fixture path');
  const fixture = load(path);
  const rows = fixture.interactions.map((it, i) => ({
    ref: it.id ?? `interactions[${i}]`,
    digest: digestRequest(it.request),
  }));

  emit(
    options.json
      ? JSON.stringify(rows, null, 2) + '\n'
      : rows.map((r) => `${r.digest}  ${r.ref}`).join('\n') + '\n',
    options,
  );
  return 0;
}

function cmdScan(paths: string[], options: Options): number {
  if (paths.length === 0) return usage('scan requires at least one fixture path');
  const all: Array<{ file: string; location: string; rule: string; note: string }> = [];

  for (const path of paths) {
    for (const f of scanFixture(load(path))) all.push({ file: path, ...f });
  }

  if (options.json) {
    emit(JSON.stringify(all, null, 2) + '\n', options);
  } else if (all.length === 0) {
    process.stdout.write(
      'No rule matched.\n\n' +
        'This is not a guarantee. Rule- and entropy-based detection have false\n' +
        'negatives; review the fixture before publishing it.\n',
    );
  } else {
    process.stdout.write(`${all.length} suspected secret(s):\n\n`);
    for (const f of all) {
      process.stdout.write(`  ${f.file}\n    ${f.location}\n    [${f.rule}] ${f.note}\n\n`);
    }
    process.stdout.write('These are suspicions, not confirmations. Review each one.\n');
  }

  // Findings are informational: `scan` reports, it does not fail a build. Use
  // it with `--json` and your own policy if you want a gate.
  return 0;
}

function cmdRedact(paths: string[], options: Options): number {
  const path = paths[0];
  if (!path) return usage('redact requires a fixture path');
  const result = redactFixture(load(path));

  emit(serializeFixture(result.value), options);

  const target = options.output ?? '<stdout>';
  process.stderr.write(
    result.rules.length === 0
      ? `No redaction rule matched ${path}. This does not mean it is free of secrets.\n`
      : `Redacted ${path} -> ${target} (${result.rules.join(', ')}). ` +
          'Detection has false negatives; review the result before committing.\n',
  );
  return 0;
}

function cmdExplain(args: string[], options: Options): number {
  const [fixturePath, requestArg] = args;
  if (!fixturePath || !requestArg) return usage('explain requires a fixture path and a request');

  const fixture = load(fixturePath);
  const request = readRequestArg(requestArg);

  const player = new Player(fixture, { explainAll: options.all, color: options.color });
  if (player.wouldMatch(request)) {
    process.stdout.write('The request matches.\n');
    return 0;
  }

  const report = player.explainRequest(request);
  emit(
    options.json
      ? JSON.stringify(report, null, 2) + '\n'
      : renderMismatch(report, { all: options.all, color: options.color }),
    options,
  );
  return 1;
}

function readRequestArg(arg: string): HifRequest {
  const text = arg.trimStart().startsWith('{') ? arg : readFileSync(arg, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new HifStructuralError(`Request argument is not valid JSON: ${(err as Error).message}`);
  }
  const r = parsed as Record<string, unknown>;
  if (typeof r['method'] !== 'string' || typeof r['url'] !== 'string') {
    throw new HifStructuralError('Request must have string "method" and "url" members');
  }
  return parsed as HifRequest;
}

function cmdDiff(args: string[], options: Options): number {
  const [aPath, bPath] = args;
  if (!aPath || !bPath) return usage('diff requires two fixture paths');

  const a = load(aPath);
  const b = load(bPath);

  const aDigests = a.interactions.map((it) => digestRequest(it.request));
  const bDigests = b.interactions.map((it) => digestRequest(it.request));

  const changes: string[] = [];
  const max = Math.max(aDigests.length, bDigests.length);
  for (let i = 0; i < max; i++) {
    const da = aDigests[i];
    const db = bDigests[i];
    if (da === undefined) {
      changes.push(`+ [${i}] only in ${bPath}: ${b.interactions[i]!.request.method} ${b.interactions[i]!.request.url}`);
    } else if (db === undefined) {
      changes.push(`- [${i}] only in ${aPath}: ${a.interactions[i]!.request.method} ${a.interactions[i]!.request.url}`);
    } else if (da !== db) {
      changes.push(`~ [${i}] request differs`);
      changes.push(`    ${aPath}: ${a.interactions[i]!.request.method} ${a.interactions[i]!.request.url}`);
      changes.push(`    ${bPath}: ${b.interactions[i]!.request.method} ${b.interactions[i]!.request.url}`);
    } else {
      const sa = JSON.stringify(a.interactions[i]!.response ?? a.interactions[i]!.fault);
      const sb = JSON.stringify(b.interactions[i]!.response ?? b.interactions[i]!.fault);
      if (sa !== sb) changes.push(`~ [${i}] response differs for ${a.interactions[i]!.request.url}`);
    }
  }

  if (options.json) {
    emit(JSON.stringify({ changes }, null, 2) + '\n', options);
  } else if (changes.length === 0) {
    process.stdout.write('Fixtures are equivalent.\n');
  } else {
    process.stdout.write(changes.join('\n') + '\n');
  }
  return changes.length === 0 ? 0 : 1;
}

function usage(message: string): number {
  process.stderr.write(`error: ${message}\n\n${USAGE}`);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
