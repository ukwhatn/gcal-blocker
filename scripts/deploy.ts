/**
 * dist/ を GAS プロジェクトへ反映する（プロジェクトのファイルを dist の内容で全置換する）
 *
 * Apps Script API は gws MCP（google-workspace-mcp）が保存している OAuth トークンで叩く。
 * トークンを持つマシンが別なら ssh 先で実行する。
 *
 * usage: bun scripts/deploy.ts <main|satellite>
 * 設定: deploy.json（scriptId、追跡）と main checkout の deploy.local.json（account / ssh / gwsDir、マシンごと・gitignore）
 */
import { spawnSync } from 'child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, extname, join, parse } from 'path';

interface LocalTarget {
  /** gws MCP のアカウント ID（gws_auth_list_accounts の account_id） */
  account: string;
  /** トークンが別マシンにあるときの ssh 接続先 */
  ssh?: string;
  /** gws MCP のディレクトリ */
  gwsDir?: string;
}

interface GasFile {
  name: string;
  type: 'SERVER_JS' | 'HTML' | 'JSON';
  source: string;
}

const DEFAULT_GWS_DIR = '~/.claude/mcp/google-workspace';
const DIST_DIR = 'dist';
const FILE_TYPES: Record<string, GasFile['type']> = {
  '.js': 'SERVER_JS',
  '.html': 'HTML',
  '.json': 'JSON',
};

// gws MCP の server.main() と同じ手順で認証を組み立てる。反映前の内容を before として返す
const PYTHON_PROGRAM = `
import base64, json
from google_workspace_mcp.auth import AccountStore, AuthManager, OAuthUserProvider, TokenStore
from google_workspace_mcp.config import Settings, resolve_client_config
payload = json.loads(base64.b64decode(PAYLOAD))
s = Settings()
store = s.resolved_store_dir()
provider = OAuthUserProvider(client_config=resolve_client_config(s), tool_required_scopes=s.tool_required_scopes,
    email_scopes=s.email_scopes, token_store=TokenStore(store), account_store=AccountStore(store),
    open_browser_default=False, callback_port=s.oauth_callback_port)
projects = AuthManager(provider).get_service('script', 'v1', account_id=payload['account']).projects()
before = projects.getContent(scriptId=payload['scriptId']).execute()
after = projects.updateContent(scriptId=payload['scriptId'], body={'files': payload['files']}).execute()
print(json.dumps({'before': before, 'after': [{'name': f['name'], 'type': f['type'], 'length': len(f['source'])} for f in after['files']]}))
`;

function main(): void {
  const target = process.argv[2];
  const mainCheckout = getMainCheckout();
  const scriptIds = readJson<Record<string, { scriptId: string }>>('deploy.json');
  const locals = readJson<Record<string, LocalTarget>>(join(mainCheckout, 'deploy.local.json'));

  const scriptId = target ? scriptIds[target]?.scriptId : undefined;
  const local = target ? locals[target] : undefined;
  if (!target || !scriptId) {
    fail(`target は ${Object.keys(scriptIds).join(' / ')} のどれか: ${target ?? '(未指定)'}`);
  }
  if (!local?.account) {
    fail(`deploy.local.json に ${target}.account がない（README「デプロイ運用」）`);
  }

  const files = readDistFiles();
  if (!files.some((file) => file.name === 'appsscript' && file.type === 'JSON')) {
    fail('dist/appsscript.json がない（マニフェスト無しで全置換するとプロジェクト設定が消える）');
  }

  const gwsDir = local.gwsDir ?? DEFAULT_GWS_DIR;
  const program = buildProgram({ scriptId, account: local.account, files });
  const command = local.ssh
    ? ['ssh', local.ssh, `cd ${gwsDir} && PATH=/opt/homebrew/bin:/usr/local/bin:$PATH uv run python -`]
    : ['uv', 'run', '--directory', gwsDir.replace(/^~/, homedir()), 'python', '-'];

  console.log(`反映先: ${target} (${scriptId}) account=${local.account}${local.ssh ? ` via ${local.ssh}` : ''}`);
  const result = spawnSync(command[0], command.slice(1), {
    input: program,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    fail(`反映に失敗した（exit ${result.status}）`);
  }

  const output = JSON.parse(result.stdout) as {
    before: { files: GasFile[] };
    after: { name: string; type: string; length: number }[];
  };
  const backupPath = writeBackup(mainCheckout, target, output.before);
  console.log(`反映前の内容: ${backupPath}`);
  console.log(`反映前: ${describe(output.before.files.map((f) => ({ ...f, length: f.source.length })))}`);
  console.log(`反映後: ${describe(output.after)}`);
}

function readDistFiles(): GasFile[] {
  return readdirSync(DIST_DIR)
    .filter((name) => FILE_TYPES[extname(name)])
    .sort()
    .map((name) => ({
      name: parse(name).name,
      type: FILE_TYPES[extname(name)],
      source: readFileSync(join(DIST_DIR, name), 'utf8'),
    }));
}

function buildProgram(payload: { scriptId: string; account: string; files: GasFile[] }): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
  return `PAYLOAD = '${encoded}'\n${PYTHON_PROGRAM}`;
}

/**
 * git 管理外の設定とバックアップは main checkout に置く
 * worktree には gitignore のファイルが無く、worktree の片付けでバックアップも消えるため
 */
function getMainCheckout(): string {
  const commonDir = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
  }).stdout.trim();
  if (!commonDir) fail('git リポジトリの中で実行する');
  return dirname(commonDir);
}

function writeBackup(mainCheckout: string, target: string, content: unknown): string {
  const dir = join(mainCheckout, '.local', 'deploy-backups');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${target}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(path, JSON.stringify(content));
  return path;
}

function describe(files: { name: string; type: string; length: number }[]): string {
  return files.map((file) => `${file.name}(${file.type}, ${file.length})`).join(' ');
}

function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    fail(`${path} を読めない: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

main();
