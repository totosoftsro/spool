/**
 * The portable regex subset of specification §7.6.2.
 *
 * Two problems are solved here, and both are about cross-language agreement:
 *
 * 1. **Rejection.** Constructs whose behaviour differs between engines — or that
 *    enable catastrophic backtracking — are rejected outright rather than passed
 *    to the host engine. A pattern that runs must mean the same thing everywhere.
 *
 * 2. **Translation.** `\d`, `\w`, `\s` and `.` are ASCII-defined by §7.6.2, but
 *    JavaScript's `\s` matches Unicode whitespace and its `.` excludes `\r`,
 *    U+2028 and U+2029 as well as `\n`. Each is rewritten to an explicit
 *    character class so the compiled pattern means exactly what the spec says.
 *
 * Validation and translation happen in one left-to-right pass. Doing them
 * separately with a pre-scan looks simpler but is wrong: a pre-scan for lazy
 * quantifiers cannot tell `a??` (lazy, excluded) from `\??` (an optional literal
 * question mark, allowed), because it does not track escape context.
 */

import { HifStructuralError } from './errors.js';

const CLASS_D = '0-9';
const CLASS_W = 'A-Za-z0-9_';
const CLASS_S = ' \\t\\n\\r\\f\\v';

/** Punctuation that `\` may escape, per §7.6.2, plus the C0 mnemonics. */
const ESCAPABLE = new Set([...'\\.^$|?*+()[]{}/-', 't', 'n', 'r', 'f', 'v']);

export interface CompiledPattern {
  source: string;
  test(subject: string): boolean;
}

/**
 * Longest subject a compiled pattern will be run against (§7.6.2).
 *
 * This is a secondary measure only. Bounding length does not prevent exponential
 * backtracking — `(a+)+b` against 40 characters already runs indefinitely — which
 * is why the structural rule forbidding a quantifier on a group is the real
 * protection. Header values and JSON strings do not legitimately reach this size.
 */
const MAX_SUBJECT = 8192;

/**
 * Validate a pattern against the §7.6.2 subset and compile it, anchored.
 *
 * @throws HifStructuralError when the pattern uses an excluded construct or is
 * not syntactically valid. §7.6.2 requires rejection rather than silently
 * accepting host-engine behaviour.
 */
export function compilePortableRegex(pattern: string): CompiledPattern {
  const translated = translate(pattern);

  let re: RegExp;
  try {
    re = new RegExp(`^(?:${translated})$`);
  } catch (err) {
    throw new HifStructuralError(`Regex ${JSON.stringify(pattern)} is not valid: ${(err as Error).message}`);
  }

  return {
    source: pattern,
    test(subject: string): boolean {
      if (subject.length > MAX_SUBJECT) {
        throw new HifStructuralError(
          `Regex subject of ${subject.length} characters exceeds the ${MAX_SUBJECT}-character bound of spec §7.6.2`,
        );
      }
      return re.test(subject);
    },
  };
}

function reject(pattern: string, why: string): never {
  throw new HifStructuralError(`Regex ${JSON.stringify(pattern)} uses ${why}, which the HIF regex subset (spec §7.6.2) excludes`);
}

function translate(pattern: string): string {
  let out = '';
  let inClass = false;
  /** True immediately after emitting something a quantifier may follow. */
  let quantifiable = false;
  let groupDepth = 0;
  /**
   * True when the last thing emitted was a closing `)`. §7.6.2 forbids a
   * quantifier on a group, because a quantified group whose body is ambiguous is
   * what makes backtracking exponential.
   */
  let afterGroup = false;

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;

    // ---- escape sequences ------------------------------------------------
    if (ch === '\\') {
      const next = pattern[i + 1];
      if (next === undefined) {
        throw new HifStructuralError(`Regex ${JSON.stringify(pattern)} ends with a trailing backslash`);
      }
      i++;

      if (next >= '1' && next <= '9') reject(pattern, 'backreferences');
      if (next === 'b' || next === 'B') reject(pattern, 'word boundaries');
      if (next === 'p' || next === 'P') reject(pattern, 'Unicode property escapes');
      if (next === 'k') reject(pattern, 'named backreferences');

      afterGroup = false;
      if (inClass) {
        if (next === 'd') out += CLASS_D;
        else if (next === 'w') out += CLASS_W;
        else if (next === 's') out += CLASS_S;
        else if (next === 'D' || next === 'W' || next === 'S') {
          reject(pattern, `\\${next} inside a character class, whose expansion is ambiguous`);
        } else if (ESCAPABLE.has(next)) out += '\\' + next;
        else reject(pattern, `the escape \\${next}`);
        continue;
      }

      if (next === 'd') out += `[${CLASS_D}]`;
      else if (next === 'D') out += `[^${CLASS_D}]`;
      else if (next === 'w') out += `[${CLASS_W}]`;
      else if (next === 'W') out += `[^${CLASS_W}]`;
      else if (next === 's') out += `[${CLASS_S}]`;
      else if (next === 'S') out += `[^${CLASS_S}]`;
      else if (ESCAPABLE.has(next)) out += '\\' + next;
      else reject(pattern, `the escape \\${next}`);

      quantifiable = true;
      continue;
    }

    // ---- inside a character class ----------------------------------------
    if (inClass) {
      out += ch;
      if (ch === ']') {
        inClass = false;
        quantifiable = true;
        afterGroup = false;
      }
      continue;
    }

    // ---- structure --------------------------------------------------------
    if (ch === '[') {
      inClass = true;
      afterGroup = false;
      out += ch;
      // A `^` or `]` immediately after `[` is literal; copying them here keeps
      // the class-termination check below from firing on `[]]`.
      if (pattern[i + 1] === '^') {
        out += '^';
        i++;
      }
      if (pattern[i + 1] === ']') {
        out += '\\]';
        i++;
      }
      quantifiable = false;
      continue;
    }

    if (ch === '(') {
      if (pattern[i + 1] === '?') {
        reject(pattern, 'groups other than plain ( ) — non-capturing, named, lookaround and inline-flag groups');
      }
      groupDepth++;
      out += '(';
      quantifiable = false;
      afterGroup = false;
      continue;
    }

    if (ch === ')') {
      if (groupDepth === 0) throw new HifStructuralError(`Regex ${JSON.stringify(pattern)} has an unmatched ")"`);
      groupDepth--;
      out += ')';
      quantifiable = true;
      afterGroup = true;
      continue;
    }

    if (ch === '*' || ch === '+' || ch === '?') {
      if (!quantifiable) {
        throw new HifStructuralError(`Regex ${JSON.stringify(pattern)} has a quantifier "${ch}" with nothing to repeat`);
      }
      if (afterGroup) rejectQuantifiedGroup(pattern, ch);
      out += ch;
      const after = pattern[i + 1];
      if (after === '?') reject(pattern, 'lazy quantifiers');
      if (after === '+') reject(pattern, 'possessive quantifiers');
      quantifiable = false;
      continue;
    }

    if (ch === '{') {
      const close = pattern.indexOf('}', i);
      if (close === -1) {
        throw new HifStructuralError(
          `Regex ${JSON.stringify(pattern)} has an unterminated "{"; write "\\{" for a literal brace`,
        );
      }
      const inner = pattern.slice(i + 1, close);
      if (!/^\d+(,\d*)?$/.test(inner)) {
        throw new HifStructuralError(
          `Regex ${JSON.stringify(pattern)} has an invalid counted quantifier "{${inner}}"; write "\\{" for a literal brace`,
        );
      }
      if (!quantifiable) {
        throw new HifStructuralError(`Regex ${JSON.stringify(pattern)} has a quantifier "{${inner}}" with nothing to repeat`);
      }
      if (afterGroup) rejectQuantifiedGroup(pattern, `{${inner}}`);
      out += `{${inner}}`;
      i = close;
      const after = pattern[i + 1];
      if (after === '?') reject(pattern, 'lazy quantifiers');
      if (after === '+') reject(pattern, 'possessive quantifiers');
      quantifiable = false;
      continue;
    }

    if (ch === '|' || ch === '^' || ch === '$') {
      out += ch;
      quantifiable = false;
      afterGroup = false;
      continue;
    }

    if (ch === '.') {
      // §7.6.2: `.` matches any character except U+000A.
      out += '[^\\n]';
      quantifiable = true;
      afterGroup = false;
      continue;
    }

    if (ch === '}' || ch === ']') {
      throw new HifStructuralError(
        `Regex ${JSON.stringify(pattern)} has an unmatched "${ch}"; write "\\${ch}" for a literal`,
      );
    }

    out += escapeLiteral(ch);
    quantifiable = true;
    afterGroup = false;
  }

  if (inClass) throw new HifStructuralError(`Regex ${JSON.stringify(pattern)} has an unterminated character class`);
  if (groupDepth > 0) throw new HifStructuralError(`Regex ${JSON.stringify(pattern)} has an unclosed "("`);
  return out;
}

function rejectQuantifiedGroup(pattern: string, quantifier: string): never {
  throw new HifStructuralError(
    `Regex ${JSON.stringify(pattern)} applies the quantifier "${quantifier}" to a group, which the HIF ` +
      'regex subset (spec §7.6.2) excludes. A quantified group is what makes backtracking exponential: ' +
      '"(a+)+b" never finishes against a run of "a" characters. Rewrite without the group, or match this ' +
      'value with a placeholder other than {{regex:...}}.',
  );
}

/** Literal characters are re-escaped so the host engine cannot reinterpret them. */
function escapeLiteral(ch: string): string {
  return /[\\^$.|?*+()[\]{}]/.test(ch) ? '\\' + ch : ch;
}
