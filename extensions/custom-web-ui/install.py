"""Install the local web UI controller into the existing portable desktop app."""
from pathlib import Path
import argparse
import datetime
import hashlib
import os
import shutil
import sys
import yaml
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'soonest-reset'))
from install import replace_plugins


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--installation', type=Path, required=True)
    args = parser.parse_args()
    root = args.installation.resolve()
    core = (root / 'core-version.txt').read_text(encoding='utf-8-sig').strip().lstrip('v')
    parts = tuple(int(p) for p in core.split('.')[:3] if p.isdigit())
    if len(parts) != 3 or parts[0] != 8 or parts < (8, 0, 53):
        raise SystemExit(f'Core {core} is not a tested v8 core (8.0.53 or newer); re-test this extension first.')
    source = Path(__file__).resolve().parent
    workspace = source.parents[1]
    binary = source / 'bin/custom-web-ui.dll'
    bun = shutil.which('bun')
    if not binary.exists() or not bun:
        raise SystemExit('Build the DLL and install Bun first.')
    config = root / 'cpa-core/config.yaml'
    text = config.read_text(encoding='utf-8-sig')
    before = yaml.safe_load(text)
    plugins = before['plugins']
    if not plugins['enabled']:
        raise SystemExit('Enable global plugin loading in the desktop app first.')
    directory = Path(plugins.get('dir', 'plugins'))
    if not directory.is_absolute():
        directory = root / 'cpa-core' / directory
    configs = plugins.setdefault('configs', {})
    previous = configs.get('custom-web-ui', {})
    configs['custom-web-ui'] = {
        'enabled': True, 'priority': 0, 'workspace': str(workspace),
        'bun_binary': bun, 'port': previous.get('port', 5173),
        'history_file': previous.get('history_file') or str(Path(os.environ['LOCALAPPDATA']) / ('CLIProxyManagementLauncher/forecast-history-' + hashlib.sha256(str(root).lower().encode()).hexdigest()[:12] + '.json')),
        # Serve the built dashboard from the plugin and start it with the core; keep any choices made earlier.
        'mode': previous.get('mode', 'static'),
        'listen': previous.get('listen', '127.0.0.1'),
        'auto_start': previous.get('auto_start', True),
        'usage_database': previous.get('usage_database') or str(root / 'usage-records' / 'usage.db'),
    }
    if configs['custom-web-ui']['mode'] == 'static' and not (workspace / 'dist' / 'index.html').exists():
        print('Note: run "bun run build" in the workspace so the plugin has a dashboard to serve.')
    updated = replace_plugins(text, plugins)
    after = yaml.safe_load(updated)
    assert {k:v for k,v in before.items() if k != 'plugins'} == {k:v for k,v in after.items() if k != 'plugins'}
    backup = Path(os.environ['LOCALAPPDATA']) / 'CLIProxyManagementLauncher/backups' / datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    backup.mkdir(parents=True)
    shutil.copy2(config, backup / 'config.yaml')
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / 'custom-web-ui.dll'
    if target.exists():
        shutil.copy2(target, backup / target.name)
    shutil.copy2(binary, target)
    launcher = Path(os.environ['LOCALAPPDATA']) / 'CLIProxyManagementLauncher'
    if launcher.exists():
        old_script = launcher / 'Start-Server.ps1'
        if old_script.exists():
            shutil.copy2(old_script, backup / old_script.name)
        shutil.copy2(workspace / 'scripts/server-launcher/Start-Server.ps1', old_script)
        (launcher / 'proxy-controller.txt').write_text(str(root / 'config.toml') + '\nhttp://127.0.0.1:8317\n')
    config.write_text(updated, encoding='utf-8')
    print('Installed and enabled Custom Web UI; desktop launcher now uses its controller.')
    print(f'Private backup: {backup}')


if __name__ == '__main__':
    main()
