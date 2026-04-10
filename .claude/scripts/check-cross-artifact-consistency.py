#!/usr/bin/env python3
"""Cross-artifact consistency checks for verify-report-gate.

Covers Checks 12, 14, 16-18: verdict matching, fix counts, frontmatter.
Reads report content from stdin. Returns JSON {"errors":[], "warnings":[]}.
"""
import glob
import json
import os
import re
import sys


def main():
    project = os.environ.get('CLAUDE_PROJECT_DIR', '.')
    content = sys.stdin.read()
    traces_dir = os.path.join(project, '.runs/agent-traces')
    errors = []
    warnings = []

    # --- Check 12: agent_verdicts in report vs actual trace verdicts ---
    match = re.search(r'agent_verdicts:\s*(.+)', content)
    if match and os.path.isdir(traces_dir):
        try:
            report_verdicts = json.loads(match.group(1).strip())
            for name, rv in report_verdicts.items():
                tp = os.path.join(traces_dir, name + '.json')
                if os.path.exists(tp):
                    try:
                        tv = json.load(open(tp)).get('verdict', 'missing')
                        if str(rv) != str(tv):
                            errors.append('agent_verdicts mismatch: ' + name + ': report=' + str(rv) + ', trace=' + str(tv))
                    except: pass
        except json.JSONDecodeError:
            pass

    # --- Check 14: Fix count cross-reference (WARN only) ---
    fix_log_path = os.path.join(project, '.runs/fix-log.md')
    if os.path.isdir(traces_dir) and os.path.exists(fix_log_path):
        try:
            fix_log = open(fix_log_path).read()
            prefix_map = {
                'design-critic': 'Fix (design-critic):',
                'ux-journeyer': 'Fix (ux-journeyer):',
                'security-fixer': 'Fix (security-fixer):'
            }
            for tf in glob.glob(os.path.join(traces_dir, '*.json')):
                name = os.path.basename(tf).replace('.json', '')
                if name.startswith('design-critic-'): continue
                try:
                    d = json.load(open(tf))
                    fixes = d.get('fixes', None)
                    if fixes is None: continue
                    prefix = prefix_map.get(name, 'Fix (' + name + '):')
                    if len(fixes) != fix_log.count(prefix):
                        warnings.append(name + ': trace=' + str(len(fixes)) + ', log=' + str(fix_log.count(prefix)))
                except: pass
        except: pass

    # --- Check 16: hard_gate_failure field present ---
    if content and 'hard_gate_failure:' not in content:
        errors.append('hard_gate_failure field missing from report frontmatter — must be true or false')

    # --- Check 17: process_violation field present ---
    if content and 'process_violation:' not in content:
        errors.append('process_violation field missing from report frontmatter — must be true or false')

    # --- Check 18: Lead-side trace field validation ---
    dc_path = os.path.join(traces_dir, 'design-critic.json')
    if os.path.exists(dc_path):
        try:
            d = json.load(open(dc_path))
            pr = d.get('pages_reviewed', 0)
            if not isinstance(pr, int) or pr < 1:
                errors.append('design-critic pages_reviewed=%s (expected int >= 1)' % pr)
        except: pass
    ux_path = os.path.join(traces_dir, 'ux-journeyer.json')
    if os.path.exists(ux_path):
        try:
            d = json.load(open(ux_path))
            ude = d.get('unresolved_dead_ends', None)
            if ude is not None and not isinstance(ude, int):
                errors.append('ux-journeyer unresolved_dead_ends=%s (expected int)' % ude)
        except: pass
    sf_path = os.path.join(traces_dir, 'security-fixer.json')
    if os.path.exists(sf_path):
        try:
            d = json.load(open(sf_path))
            uc = d.get('unresolved_critical', None)
            if uc is not None and not isinstance(uc, int):
                errors.append('security-fixer unresolved_critical=%s (expected int)' % uc)
        except: pass

    print(json.dumps({'errors': errors, 'warnings': warnings}))


if __name__ == "__main__":
    main()
