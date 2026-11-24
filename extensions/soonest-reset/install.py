"""Install the tested native extension into an existing portable EasyCLIProxyAPI."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import shutil
import tomllib
import yaml


def replace_plugins(text, value):
    match = re.search(r'(?m)^plugins:\s*\n', text)
    if not match:
        raise ValueError('Expected v8 plugins section; configuration was not modified')
    tail = re.search(r'(?m)^[A-Za-z0-9_-]+:', text[match.end():])
    end = match.end() + tail.start() if tail else len(text)
    return text[:match.start()] + yaml.safe_dump({'plugins': value}, sort_keys=False) + text[end:]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--installation', type=Path, required=True)
    args = parser.parse_args()
    root = args.installation.resolve()
    core = root / 'cpa-core'
    if (root / 'core-version.txt').read_text(encoding='utf-8-sig').strip().lstrip('v') != '8.0.53':
        raise SystemExit('This plugin was tested against core v8.0.53; re-test before installing on another version')
    config = core / 'config.yaml'
    desktop = root / 'config.toml'
    binary = Path(__file__).parent / 'bin/soonest-reset.dll'
    if not binary.is_file():
        raise SystemExit('Run build.ps1 successfully before installing')
    text = config.read_text(encoding='utf-8-sig')
    parsed = yaml.safe_load(text)
    plugins = parsed.get('plugins', {})
    plugin_dir = Path(plugins.get('dir') or 'plugins')
    if not plugin_dir.is_absolute():
        # Use an absolute discovery path to avoid reliance on the launch directory.
        plugin_dir = core / plugin_dir
    plugin_dir = plugin_dir.resolve()
    existing = list(plugin_dir.glob('*.dll'))
    if any(p.name != 'soonest-reset.dll' for p in existing) and not plugins.get('enabled'):
        raise SystemExit('Other disabled native plugins exist. Review them before globally enabling plugins.')
    local = Path(os.environ['LOCALAPPDATA']) / 'CLIProxySoonestReset'
    seed = local / 'seed.json'
    state = local / 'observations.json'
    if not state.exists() and seed.exists():
        shutil.copy2(seed, state)
    plugins['enabled'] = True
    plugins['dir'] = str(plugin_dir)
    configs = plugins.setdefault('configs', {})
    configs['soonest-reset'] = {'enabled': True, 'priority': 0, 'state_file': str(state)}
    updated = replace_plugins(text, plugins)
    check = yaml.safe_load(updated)
    assert {k:v for k,v in check.items() if k != 'plugins'} == {k:v for k,v in parsed.items() if k != 'plugins'}
    toml = desktop.read_text(encoding='utf-8-sig')
    changed, count = re.subn(r'(?m)^plugins-enabled\s*=\s*(?:true|false)\s*$', 'plugins-enabled = true', toml)
    if count != 1:
        raise SystemExit('Expected exactly one desktop plugins-enabled setting; files were not modified')
    assert tomllib.loads(changed)['plugins-enabled'] is True
    stamp = dt.datetime.now().strftime('%Y%m%d-%H%M%S')
    backup = local / 'backups' / stamp
    backup.mkdir(parents=True)
    shutil.copy2(config, backup / 'config.yaml')
    shutil.copy2(desktop, backup / 'config.toml')
    plugin_dir.mkdir(parents=True, exist_ok=True)
    target = plugin_dir / 'soonest-reset.dll'
    if target.exists():
        shutil.copy2(target, backup / target.name)
    shutil.copy2(binary, target)
    # Change the desktop preference before the watched core YAML, preserving affinity.
    desktop.write_text(changed, encoding='utf-8')
    config.write_text(updated, encoding='utf-8')
    print('Installed soonest-reset.dll and enabled native plugin loading in both configurations.')
    print('Fallback routing strategy and session-affinity settings were preserved.')
    print(f'Private backup: {backup}')
    print(f'Runtime diagnostic counters: {state}.status.json')


if __name__ == '__main__':
    main()
