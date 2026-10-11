import { describe, expect, it } from 'vitest';
import { REDACTED, maskSecrets, maskSecretsCounted } from '../../src/shared/secretMasking';
import { redactString } from '../../src/main/log/redact';

interface SecretCase {
  name: string;
  input: string;
  mustNotContain: string[];
}

// Every fixture below is synthetic. Lines holding anything that looks like a credential carry the
// detect-secrets allowlist marker.
// A section sign inside a fixture breaks up credential-shaped literals so source scanners do not flag them;
// it is removed before the fixture is used.
const unmark = (text: string): string => text.replace(/§/g, '');

const RAW_SECRET_CASES: SecretCase[] = [
  // --- what redact.ts masked before ---
  { name: 'pem openssh key', input: 'before\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\nQyNTUxOQAAACD\n-----END OPENSSH PRIVATE KEY-----\nafter', mustNotContain: ['b3BlbnNzaC1rZXk', 'QyNTUxOQAAACD'] }, // pragma: allowlist secret
  { name: 'pem key without end marker', input: 'ls\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nMIIEowIBAAKCAQEB', mustNotContain: ['MIIEowIBAAKCAQEA', 'MIIEowIBAAKCAQEB'] }, // pragma: allowlist secret
  { name: 'aws access key id', input: 'key AKIA§ABCDEFGHIJKLMNOP and ASIA§ABCDEFGHIJKLMNOP', mustNotContain: ['AKIA§ABCDEFGHIJKLMNOP', 'ASIA§ABCDEFGHIJKLMNOP'] }, // pragma: allowlist secret
  { name: 'aws_secret_access_key', input: 'aws_secret_access_key = wJalr§XUtnFEMI/K7MDENG/bPxRfiCYzzzzzzzzzz', mustNotContain: ['wJalr§XUtnFEMI'] }, // pragma: allowlist secret
  { name: 'aws_session_token', input: 'aws_session_token: IQoJb3JpZ2luX2VjEXAMPLETOKEN', mustNotContain: ['IQoJb3JpZ2luX2VjEXAMPLETOKEN'] }, // pragma: allowlist secret
  { name: 'bearer token', input: 'curl -H "x: Bearer abcdefgh12345" url', mustNotContain: ['abcdefgh12345'] }, // pragma: allowlist secret
  { name: 'url user and password', input: 'git clone https://bob:hunter2@example.com/repo.git', mustNotContain: ['hunter2'] }, // pragma: allowlist secret
  { name: 'MYSQL_PASSWORD env', input: 'MYSQL_PASSWORD=hunter2', mustNotContain: ['hunter2'] }, // pragma: allowlist secret
  { name: 'passphrase colon', input: 'passphrase: correct-horse', mustNotContain: ['correct-horse'] }, // pragma: allowlist secret
  { name: 'passwd and secret', input: 'passwd=abc123 MY_SECRET=xyz789', mustNotContain: ['abc123', 'xyz789'] }, // pragma: allowlist secret
  { name: 'token assignment', input: 'GITHUB_TOKEN=gh-not-a-known-format-1234', mustNotContain: ['gh-not-a-known-format-1234'] }, // pragma: allowlist secret
  { name: 'pin assignment', input: 'pin=482913 fido2Pin: 998877', mustNotContain: ['482913', '998877'] }, // pragma: allowlist secret
  // --- assignments and key/value forms ---
  { name: 'API_KEY', input: 'export API_KEY=k3y-value-1', mustNotContain: ['k3y-value-1'] }, // pragma: allowlist secret
  { name: 'OPENAI_API_KEY', input: 'OPENAI_API_KEY=plainvalue99', mustNotContain: ['plainvalue99'] }, // pragma: allowlist secret
  { name: 'apikey run together', input: 'apikey: plainvalue98', mustNotContain: ['plainvalue98'] }, // pragma: allowlist secret
  { name: 'camelCase apiKey and accessKey', input: 'apiKey=v1plain accessKey=v2plain', mustNotContain: ['v1plain', 'v2plain'] }, // pragma: allowlist secret
  { name: 'PRIVATE_KEY', input: 'PRIVATE_KEY=privvalue1', mustNotContain: ['privvalue1'] }, // pragma: allowlist secret
  { name: 'DB_PASS and PASS', input: 'DB_PASS=dbp4ss PASS=p4ss', mustNotContain: ['dbp4ss', '=p4ss'] }, // pragma: allowlist secret
  { name: 'MYSQL_PWD and pwd', input: 'MYSQL_PWD=sqlpw1 pwd=lowerpw2 Pwd=mixedpw3', mustNotContain: ['sqlpw1', 'lowerpw2', 'mixedpw3'] }, // pragma: allowlist secret
  { name: 'access and secret key names', input: 'AWS_ACCESS_KEY_ID=nonakia1 SECRET_ACCESS_KEY=sak2 secretKey=sk3', mustNotContain: ['nonakia1', 'sak2', 'sk3'] }, // pragma: allowlist secret
  { name: 'client_secret yaml', input: 'client_secret: yamlvalue1', mustNotContain: ['yamlvalue1'] }, // pragma: allowlist secret
  { name: 'credentials ini', input: 'credentials = inivalue1', mustNotContain: ['inivalue1'] }, // pragma: allowlist secret
  { name: 'json password', input: '{"user": "bob", "password": "jsonvalue1"}', mustNotContain: ['jsonvalue1'] }, // pragma: allowlist secret
  { name: 'json value with spaces', input: '{"password": "two words here", "next": 1}', mustNotContain: ['two words', 'words here'] }, // pragma: allowlist secret
  { name: 'json escaped quote', input: '{"password": "ab\\"cd-tail"}', mustNotContain: ['cd-tail'] }, // pragma: allowlist secret
  { name: 'single quoted with spaces', input: "password='my pass phrase' next", mustNotContain: ['my pass', 'phrase'] }, // pragma: allowlist secret
  { name: 'double quoted with spaces', input: 'DB_PASSWORD="spaced out secret" next', mustNotContain: ['spaced', 'secret"'] }, // pragma: allowlist secret
  { name: 'python dict', input: "{'api_key': 'pyvalue1', 'x': 1}", mustNotContain: ['pyvalue1'] }, // pragma: allowlist secret
  { name: 'kubeconfig client-key-data', input: 'users:\n- user:\n    client-key-data: Zm9vYmFyYmF6cXV4\n    token: notajwtvalue1', mustNotContain: ['Zm9vYmFyYmF6cXV4', 'notajwtvalue1'] }, // pragma: allowlist secret
  { name: 'azure AccountKey', input: 'DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=abc123+/xyz==;EndpointSuffix=core.windows.net', mustNotContain: ['abc123+/xyz'] }, // pragma: allowlist secret
  { name: 'azure SharedAccessKey', input: 'Endpoint=sb://ns.servicebus.windows.net/;SharedAccessKeyName=root;SharedAccessKey=c2hhcmVkLWtleS12YWx1ZQ==', mustNotContain: ['c2hhcmVkLWtleS12YWx1ZQ'] }, // pragma: allowlist secret
  { name: 'azure sas sig', input: 'https://acct.blob.core.windows.net/c/b?sv=2022-11-02&sig=Zm9vJTJCYmFy%3D&se=2030-01-01', mustNotContain: ['Zm9vJTJCYmFy'] }, // pragma: allowlist secret
  { name: 'query string access_token', input: 'GET /v1/me?access_token=qs-token-value&fields=id', mustNotContain: ['qs-token-value'] }, // pragma: allowlist secret
  { name: 'connection string Password', input: 'Server=db;User Id=sa;Password=conn pw;Database=x', mustNotContain: ['conn'] }, // pragma: allowlist secret
  { name: 'dotted property name', input: 'spring.datasource.password=dotvalue1', mustNotContain: ['dotvalue1'] }, // pragma: allowlist secret
  { name: 'docker config auth', input: '"auth": "dXNlcjpwYXNzd29yZDEyMzQ1Ng=="', mustNotContain: ['dXNlcjpwYXNzd29yZDEyMzQ1Ng'] }, // pragma: allowlist secret
  { name: 'helm set', input: 'helm install x --set auth.password=helmvalue1,other=2', mustNotContain: ['helmvalue1'] }, // pragma: allowlist secret
  { name: 'from-literal', input: 'kubectl create secret generic s --from-literal=password=literalvalue1', mustNotContain: ['literalvalue1'] }, // pragma: allowlist secret
  { name: 'xml element', input: '<server><password>xmlvalue1</password></server>', mustNotContain: ['xmlvalue1'] }, // pragma: allowlist secret
  { name: 'powershell env', input: '$env:API_KEY = "psvalue1"', mustNotContain: ['psvalue1'] }, // pragma: allowlist secret
  { name: 'quoted pair inside curl header', input: "curl -H 'X-Api-Key: header-value-1' https://example.com", mustNotContain: ['header-value-1'] }, // pragma: allowlist secret
  { name: 'uppercase plural names', input: 'DB_PASSWORDs=plural1 APP_SECRETs: plural2', mustNotContain: ['plural1', 'plural2'] }, // pragma: allowlist secret
  { name: 'PWD with a value that is not a path', input: 'PWD=notapath1 DRIVER={ODBC};UID=sa;PWD=odbcpw1;', mustNotContain: ['notapath1', 'odbcpw1'] }, // pragma: allowlist secret
  { name: 'flag followed by a spaced equals sign', input: 'tool --token = spaced1', mustNotContain: ['spaced1'] }, // pragma: allowlist secret
  { name: 'query string keeps the other parameters', input: 'GET /cb?state=ok&code=1&password=qspw1&next=%2Fhome#frag', mustNotContain: ['qspw1'] }, // pragma: allowlist secret
  { name: 'secret glued to a closing quote', input: 'export DB_PASSWORD="quoted1"glued1 && ls', mustNotContain: ['quoted1', 'glued1'] }, // pragma: allowlist secret
  { name: 'quoted value longer than the quote limit', input: `password="${'long secret words '.repeat(400)}" next`, mustNotContain: ['long secret', 'words'] }, // pragma: allowlist secret
  // --- HTTP headers ---
  { name: 'authorization basic', input: 'Authorization: Basic dXNlcjpwYXNzd29yZA==', mustNotContain: ['dXNlcjpwYXNzd29yZA'] }, // pragma: allowlist secret
  { name: 'authorization bearer', input: '> Authorization: Bearer opaque-token-value', mustNotContain: ['opaque-token-value'] }, // pragma: allowlist secret
  { name: 'authorization token scheme', input: 'Authorization: token not-a-real-gh-token', mustNotContain: ['not-a-real-gh-token'] }, // pragma: allowlist secret
  { name: 'authorization digest', input: 'Authorization: Digest username="bob", realm="r", nonce="n0nce", response="r3sponse"', mustNotContain: ['bob', 'n0nce', 'r3sponse'] }, // pragma: allowlist secret
  { name: 'authorization lowercase', input: 'authorization: negotiate YIIabcdefghijkl', mustNotContain: ['YIIabcdefghijkl'] }, // pragma: allowlist secret
  { name: 'proxy-authorization', input: 'Proxy-Authorization: Basic cHJveHk6cHc=', mustNotContain: ['cHJveHk6cHc'] }, // pragma: allowlist secret
  { name: 'authorization in json', input: '{"Authorization": "Bearer json-bearer-value", "Accept": "*/*"}', mustNotContain: ['json-bearer-value'] }, // pragma: allowlist secret
  { name: 'authorization in curl -H', input: 'curl -H "Authorization: Bearer curl-bearer-value" https://example.com/api', mustNotContain: ['curl-bearer-value'] }, // pragma: allowlist secret
  { name: 'x-api-key header', input: 'X-Api-Key: xapikeyvalue1', mustNotContain: ['xapikeyvalue1'] }, // pragma: allowlist secret
  { name: 'x-auth-token header', input: 'x-auth-token: xauthvalue1', mustNotContain: ['xauthvalue1'] }, // pragma: allowlist secret
  { name: 'private-token header', input: 'PRIVATE-TOKEN: privtokenvalue1', mustNotContain: ['privtokenvalue1'] }, // pragma: allowlist secret
  { name: 'cookie header', input: 'Cookie: session=abc123; csrf=def456; theme=dark', mustNotContain: ['abc123', 'def456', 'theme=dark'] }, // pragma: allowlist secret
  { name: 'set-cookie header', input: 'Set-Cookie: sid=ghi789; Path=/; HttpOnly; Secure', mustNotContain: ['ghi789'] }, // pragma: allowlist secret
  { name: 'cookie in curl -H', input: "curl -H 'Cookie: sid=jkl012; a=b' https://example.com", mustNotContain: ['jkl012'] }, // pragma: allowlist secret
  // --- token formats ---
  { name: 'github ghp', input: 'ghp_1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P7q8R', mustNotContain: ['ghp_1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P7q8R'] }, // pragma: allowlist secret
  { name: 'github gho ghu ghs ghr', input: 'gho_1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P7q8R ghu_1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P7q8R ghs_1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P7q8R ghr_1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P7q8R', mustNotContain: ['gho_1a2B', 'ghu_1a2B', 'ghs_1a2B', 'ghr_1a2B'] }, // pragma: allowlist secret
  { name: 'github fine-grained pat', input: 'github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', mustNotContain: ['github_pat_11ABCDEFG0'] }, // pragma: allowlist secret
  { name: 'anthropic key', input: 'ANTHROPIC=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdEf', mustNotContain: ['sk-ant-api03-AbCdEf'] }, // pragma: allowlist secret
  { name: 'openai key', input: 'sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKl', mustNotContain: ['sk-AbCdEf'] }, // pragma: allowlist secret
  { name: 'openai project key', input: 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_AbCdEf-GhIjKl', mustNotContain: ['sk-proj-AbCdEf'] }, // pragma: allowlist secret
  { name: 'slack tokens', input: 'xoxb-1234567890-abcdefghij xoxp-1234567890-abcdefghij xoxa-1234567890-abcdefghij xoxr-1234567890-abcdefghij xoxs-1234567890-abcdefghij', mustNotContain: ['xoxb-', 'xoxp-', 'xoxa-', 'xoxr-', 'xoxs-'] }, // pragma: allowlist secret
  { name: 'slack webhook', input: 'curl -X POST https://hooks.slack.com/services/T0000000/B0000000/abcdefghijklmnopqrstuvwx -d x', mustNotContain: ['T0000000', 'abcdefghijklmnopqrstuvwx'] }, // pragma: allowlist secret
  { name: 'discord webhook', input: 'https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz-_0123456789', mustNotContain: ['AbCdEfGhIjKlMnOpQrStUvWxYz'] }, // pragma: allowlist secret
  { name: 'google api key', input: 'key=AIzaSyA-1234567890abcdefghijklmnopqrstu', mustNotContain: ['AIzaSyA-1234567890'] }, // pragma: allowlist secret
  { name: 'google oauth client secret and access token', input: 'GOCSPX-AbCdEfGhIjKlMnOpQrStUvWx ya29.a0AfH6SMBabcdefghijklmnopqrstuvwxyz', mustNotContain: ['GOCSPX-AbCd', 'ya29.a0AfH6'] }, // pragma: allowlist secret
  { name: 'gitlab pat', input: 'glpat-AbCdEfGhIjKlMnOpQrSt', mustNotContain: ['glpat-AbCdEf'] }, // pragma: allowlist secret
  { name: 'npm token', input: 'npm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', mustNotContain: ['npm_AbCdEf'] }, // pragma: allowlist secret
  { name: 'stripe keys', input: 'sk_live_AbCdEfGhIjKlMnOp rk_live_AbCdEfGhIjKlMnOp sk_test_AbCdEfGhIjKlMnOp whsec_AbCdEfGhIjKlMnOpQrSt', mustNotContain: ['sk_live_', 'rk_live_', 'sk_test_', 'whsec_'] }, // pragma: allowlist secret
  { name: 'sendgrid key', input: 'SG§.AbCdEfGhIjKlMnOpQrStUv.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfG', mustNotContain: ['SG§.AbCdEf'] }, // pragma: allowlist secret
  { name: 'hugging face token', input: 'hf_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', mustNotContain: ['hf_AbCdEf'] }, // pragma: allowlist secret
  { name: 'digitalocean token', input: 'dop_v1§_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', mustNotContain: ['dop_v1§_0123'] }, // pragma: allowlist secret
  { name: 'pypi, docker hub, shopify, telegram', input: 'pypi-AgEIcHlwaS5vcmcAbCdEfGhIjKlMnOpQrStUvWxYz0123 dckr_pat_AbCdEfGhIjKlMnOpQr shpat§_0123456789abcdef0123456789abcdef 123456789:AAFabcdefghijklmnopqrstuvwxyz0123456', mustNotContain: ['pypi-AgEI', 'dckr_pat_', 'shpat§_', '123456789:AAF'] }, // pragma: allowlist secret
  { name: 'bare jwt', input: 'token seen: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk', mustNotContain: ['eyJhbGciOiJIUzI1NiIs', 'dBjftJeZ4CVP'] }, // pragma: allowlist secret
  // --- command lines ---
  { name: '--password value', input: 'tool --password hunter2 --verbose', mustNotContain: ['hunter2'] }, // pragma: allowlist secret
  { name: '--password=value', input: 'tool --password=hunter2', mustNotContain: ['hunter2'] }, // pragma: allowlist secret
  { name: '--passwd --pass --passphrase', input: 'a --passwd v1x b --pass v2x c --passphrase v3x', mustNotContain: ['v1x', 'v2x', 'v3x'] }, // pragma: allowlist secret
  { name: '--secret --token --api-key --apikey', input: 'a --secret s1x b --token=t2x c --api-key k3x d --apikey k4x', mustNotContain: ['s1x', 't2x', 'k3x', 'k4x'] }, // pragma: allowlist secret
  { name: '--access-key --secret-key --client-secret --auth-token', input: 'a --access-key a1x --secret-key s2x --client-secret c3x --auth-token t4x', mustNotContain: ['a1x', 's2x', 'c3x', 't4x'] }, // pragma: allowlist secret
  { name: '--http-password --ftp-password --proxy-password', input: 'wget --http-password h1x --ftp-password=f2x --proxy-password p3x url', mustNotContain: ['h1x', 'f2x', 'p3x'] }, // pragma: allowlist secret
  { name: '--password with quoted value', input: 'tool --password "two words" next', mustNotContain: ['two words', 'words'] }, // pragma: allowlist secret
  { name: 'mysql -pSECRET', input: 'mysql -h db -uroot -pmysecret mydb', mustNotContain: ['mysecret'] }, // pragma: allowlist secret
  { name: 'mysqldump -p quoted', input: "mysqldump -u root -p'my secret' db > dump.sql", mustNotContain: ['my secret', 'secret\''] }, // pragma: allowlist secret
  { name: 'mysqladmin and mariadb', input: 'mysqladmin -uroot -pa1b2 status; mariadb -u root -pc3d4 -e "select 1"', mustNotContain: ['a1b2', 'c3d4'] }, // pragma: allowlist secret
  { name: 'docker exec mysql', input: 'docker exec -it db mysql -uroot -pcontainerpw -e "show databases"', mustNotContain: ['containerpw'] }, // pragma: allowlist secret
  { name: 'sshpass -p', input: 'sshpass -p sshpw1 ssh -p 2222 user@host', mustNotContain: ['sshpw1'] }, // pragma: allowlist secret
  { name: 'sshpass -p quoted', input: "sshpass -p 'ssh pw 2' scp file host:/tmp", mustNotContain: ['ssh pw 2'] }, // pragma: allowlist secret
  { name: 'openssl pass:', input: 'openssl enc -aes-256-cbc -in a -out b -passin pass:opensslpw1 -passout pass:opensslpw2', mustNotContain: ['opensslpw1', 'opensslpw2'] }, // pragma: allowlist secret
  { name: 'openssl -pass quoted', input: 'openssl rsa -in k.pem -pass "pass:with spaces" -out o.pem', mustNotContain: ['with spaces', 'spaces'] }, // pragma: allowlist secret
  { name: 'curl -u', input: 'curl -u alice:curlpw1 https://example.com/api', mustNotContain: ['curlpw1'] }, // pragma: allowlist secret
  { name: 'curl --user', input: 'curl --user alice:curlpw2 https://example.com/api', mustNotContain: ['curlpw2'] }, // pragma: allowlist secret
  { name: 'curl --user= and --proxy-user', input: 'curl --user=alice:curlpw3 --proxy-user bob:curlpw4 https://example.com', mustNotContain: ['curlpw3', 'curlpw4'] }, // pragma: allowlist secret
  { name: 'curl -u quoted', input: "curl -u 'alice:curl pw 5' https://example.com", mustNotContain: ['curl pw 5', 'pw 5'] }, // pragma: allowlist secret
  { name: 'curl cookie jar string', input: "curl -b 'sid=cookievalue1' https://example.com", mustNotContain: ['cookievalue1'] }, // pragma: allowlist secret
  { name: 'docker login -p', input: 'docker login -u bob -p dockerpw1 registry.example.com', mustNotContain: ['dockerpw1'] }, // pragma: allowlist secret
  { name: 'redis-cli -a and ldapsearch -w', input: 'redis-cli -h h -a redispw1 ping; ldapsearch -x -D cn=admin -w ldappw1', mustNotContain: ['redispw1', 'ldappw1'] }, // pragma: allowlist secret
  { name: 'sql identified by', input: "CREATE USER 'bob'@'%' IDENTIFIED BY 'sqlpw1'; ALTER ROLE app WITH PASSWORD 'sqlpw2';", mustNotContain: ['sqlpw1', 'sqlpw2'] }, // pragma: allowlist secret
  { name: 'netrc one-liner', input: 'machine example.com login bob password netrcpw1', mustNotContain: ['netrcpw1'] }, // pragma: allowlist secret
  // --- URLs ---
  { name: 'redis empty user', input: 'redis://:redispw2@cache.internal:6379/0', mustNotContain: ['redispw2'] }, // pragma: allowlist secret
  { name: 'user:pw@ in scheme list', input: 'postgres://app:pgpw1@db:5432/app amqp://guest:amqppw1@mq', mustNotContain: ['pgpw1', 'amqppw1'] }, // pragma: allowlist secret
  { name: 'password containing @', input: 'https://bob:p@ss-word@example.com/path', mustNotContain: ['p@ss', 'ss-word'] }, // pragma: allowlist secret
  { name: 'token as url userinfo', input: 'git clone https://a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0@github.com/org/repo.git', mustNotContain: ['a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'] }, // pragma: allowlist secret
  // --- private keys ---
  { name: 'pgp private key block', input: 'x\n-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQdGBF\n=abcd\n-----END PGP PRIVATE KEY BLOCK-----\ny', mustNotContain: ['lQdGBF', '=abcd'] }, // pragma: allowlist secret
  { name: 'rsa ec dsa encrypted keys', input: '-----BEGIN RSA PRIVATE KEY-----\nrsabody1\n-----END RSA PRIVATE KEY-----\n-----BEGIN EC PRIVATE KEY-----\necbody1\n-----END EC PRIVATE KEY-----\n-----BEGIN DSA PRIVATE KEY-----\ndsabody1\n-----END DSA PRIVATE KEY-----\n-----BEGIN ENCRYPTED PRIVATE KEY-----\nencbody1\n-----END ENCRYPTED PRIVATE KEY-----\n-----BEGIN PRIVATE KEY-----\npk8body1\n-----END PRIVATE KEY-----', mustNotContain: ['rsabody1', 'ecbody1', 'dsabody1', 'encbody1', 'pk8body1'] }, // pragma: allowlist secret
  { name: 'orphan end marker masks the key lines above it', input: 'tail of a cut key\nQyNTUxOQAAACDorphanbody\n-----END OPENSSH PRIVATE KEY-----\n$ ls', mustNotContain: ['orphanbody'] }, // pragma: allowlist secret
  { name: 'private key inside json', input: '{"private_key_id": "kid1", "private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBg\\n-----END PRIVATE KEY-----\\n"}', mustNotContain: ['MIIEvQIBADANBg', 'kid1'] }, // pragma: allowlist secret
  { name: 'base64 encoded pem key', input: 'tls.key: LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1JSUV2Z0lCQURBTkJna3Foa2lHOXcwQkFRRUZBQVNDQktnd2dnU2tBZ0VBQW9JQkFRQw==', mustNotContain: ['LS0tLS1CRUdJTiBQUklWQVRF'] }, // pragma: allowlist secret
  { name: 'wrapped base64 pem key', input: 'LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVktLS0tLQpNSUlFcEFJQkFBS0NBUUVBeHh4eHh4eHh4eHh4eHh4\neHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4\ndone', mustNotContain: ['LS0tLS1CRUdJTiBSU0Eg', 'eHh4eHh4eHh4'] }, // pragma: allowlist secret
  // --- reviewer findings: names that live somewhere else than next to the value ---
  { name: 'k8s env entry in yaml', input: 'env:\n- name: DB_PASSWORD\n  value: hunter2xyz\n- name: LOG_LEVEL\n  value: info', mustNotContain: ['hunter2xyz'] }, // pragma: allowlist secret
  { name: 'k8s env entry in json', input: '{"name":"DB_PASSWORD","value":"hunter2xyz"}', mustNotContain: ['hunter2xyz'] }, // pragma: allowlist secret
  { name: 'env entry with the value first', input: '{"value":"hunter2xyz","name":"DB_PASSWORD"}', mustNotContain: ['hunter2xyz'] }, // pragma: allowlist secret
  { name: 'ecs environment list', input: '"environment": [{"name": "API_TOKEN", "value": "abc123def"}, {"name": "X", "value": "y"}]', mustNotContain: ['abc123def'] }, // pragma: allowlist secret
  { name: 'kubectl get secret yaml', input: 'apiVersion: v1\ndata:\n  .dockerconfigjson: eyJhdXRocyI6eyJyZWcuaW8iOnsiYXV0aCI6IlltOWlPbWgxYm5SbGNqST0ifX19\n  DATABASE_URL: cG9zdGdyZXM6Ly9hcHA6aHVudGVyMkBkYjo1NDMyL2FwcA==\nkind: Secret', mustNotContain: ['eyJhdXRocyI6', 'cG9zdGdyZXM6'] }, // pragma: allowlist secret
  { name: 'secret manifest with stringData and kind first', input: 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: x\ntype: Opaque\nstringData:\n  FOO: barbazqux\n  other: v', mustNotContain: ['barbazqux'] }, // pragma: allowlist secret
  { name: 'secret manifest as json', input: '{"apiVersion": "v1", "data": {"DATABASE_URL": "cG9zdGdyZXM6Ly9hcHA6aHVudGVyMkBkYjo1NDMyL2FwcA=="}, "kind": "Secret"}', mustNotContain: ['cG9zdGdyZXM6'] }, // pragma: allowlist secret
  { name: 'last-applied-configuration annotation', input: '"kubectl.kubernetes.io/last-applied-configuration": "{\\"data\\":{\\"token\\":\\"dG9rZW52YWx1ZQ==\\"},\\"kind\\":\\"Secret\\"}"', mustNotContain: ['dG9rZW52YWx1ZQ'] }, // pragma: allowlist secret
  { name: 'json inside a json string', input: '"{\\"password\\":\\"hunter2\\"}"', mustNotContain: ['hunter2'] }, // pragma: allowlist secret
  { name: 'ssm secure string', input: '{"Parameter": {"Name": "/prod/db/password", "Type": "SecureString", "Value": "hunter2xyz"}}', mustNotContain: ['hunter2xyz'] }, // pragma: allowlist secret
  { name: 'secure string whatever its name', input: '{"Name": "/prod/db/dsn", "Type": "SecureString", "Value": "hunter2xyz"}', mustNotContain: ['hunter2xyz'] }, // pragma: allowlist secret
  { name: 'wp-config define', input: "define( 'DB_PASSWORD', 'hunter2xyz' );\ndefine( 'AUTH_KEY',         'Xk9f!jq2LmPabc' );\ndefine('SECURE_AUTH_SALT', 'abc123xyz789');", mustNotContain: ['hunter2xyz', 'Xk9f', 'abc123xyz789'] }, // pragma: allowlist secret
  { name: 'keyed assignment', input: "os.environ['DB_PASSWORD'] = 'hunter2xyz'\nconfig['password'] = 'hunter3xyz'", mustNotContain: ['hunter2xyz', 'hunter3xyz'] }, // pragma: allowlist secret
  { name: 'web.config add key value', input: '<add key="password" value="hunter2xyz" />', mustNotContain: ['hunter2xyz'] }, // pragma: allowlist secret
  { name: 'hadoop name value', input: '<property><name>fs.s3a.secret.key</name><value>hunter3xyz</value></property>', mustNotContain: ['hunter3xyz'] }, // pragma: allowlist secret
  // --- whitespace separated configuration ---
  { name: 'netrc on several lines', input: 'machine api.github.com\n  login bob\n  password hunter2xyz', mustNotContain: ['hunter2xyz'] }, // pragma: allowlist secret
  { name: 'directives without a separator', input: 'requirepass hunter2xyz\nmasterauth hunter3xyz\nauth_pass hunter4xyz\nstats auth admin:hunter5xyz', mustNotContain: ['hunter2xyz', 'hunter3xyz', 'hunter4xyz', 'hunter5xyz'] }, // pragma: allowlist secret
  { name: 'bind, ldap and msmtp directives', input: 'bindpw hunter6xyz\npassword hunter7xyz\nsecret "hunter8xyz";', mustNotContain: ['hunter6xyz', 'hunter7xyz', 'hunter8xyz'] }, // pragma: allowlist secret
  { name: 'haproxy userlist', input: 'user admin insecure-password hunter9xyz', mustNotContain: ['hunter9xyz'] }, // pragma: allowlist secret
  { name: 'ipsec.secrets', input: '%any 10.0.0.1 : PSK "hunter2xyzhunter"', mustNotContain: ['hunter2xyzhunter'] }, // pragma: allowlist secret
  { name: 'padding wider than eight blanks', input: 'SecretID:         00000000-1111-2222-3333-444444444444\nPassword:         hunter2xyz', mustNotContain: ['00000000-1111', 'hunter2xyz'] }, // pragma: allowlist secret
  { name: 'vault token table', input: 'Key                  Value\n---                  -----\ntoken                hvs.CAESIJlWQabcdefghijklmnopqrstuvwxyz0123456789\ntoken_accessor       abcdefghijklmnopqrstuvwx', mustNotContain: ['hvs.CAESIJ'] }, // pragma: allowlist secret
  { name: 'vault kv table and psql expanded display', input: 'Key         Value\n---         -----\npassword    hunter2xyz\n| adminPass | hunter3xyz |\npassword | hunter4xyz', mustNotContain: ['hunter2xyz', 'hunter3xyz', 'hunter4xyz'] }, // pragma: allowlist secret
  { name: 'labels with spaces', input: 'AWS Secret Access Key [None]: wJalr§XUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\nAPI Key: abcdef0123456789\nSecret ID    = 00000000-1111-2222-3333-444444444444', mustNotContain: ['wJalr§XUtnFEMI', 'abcdef0123456789', '00000000-1111'] }, // pragma: allowlist secret
  // --- names ---
  { name: 'env names ending in KEY', input: 'APP_KEY=base64:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG=\nAZURE_STORAGE_KEY=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG==\nDEPLOY_KEY=dk1value', mustNotContain: ['abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG', 'dk1value'] }, // pragma: allowlist secret
  { name: 'more names ending in KEY', input: 'SESSION_KEY=s1v HMAC_KEY=s2v LICENSE_KEY=s3v STRIPE_KEY=s4v SERVICE_KEY=s5v CONSUMER_KEY=s6v', mustNotContain: ['s1v', 's2v', 's3v', 's4v', 's5v', 's6v'] }, // pragma: allowlist secret
  { name: 'run-together PASS PW PWD names', input: 'export SSHPASS=hunter2xyz\nDBPASS=hunter3xyz ROOTPW=hunter4xyz DBPWD=hunter5xyz', mustNotContain: ['hunter2xyz', 'hunter3xyz', 'hunter4xyz', 'hunter5xyz'] }, // pragma: allowlist secret
  { name: 'auth names holding user:password', input: 'BASIC_AUTH=bob:hunter2xyz', mustNotContain: ['hunter2xyz'] }, // pragma: allowlist secret
  { name: 'short base64 auth', input: '//registry.example.com/:_auth=dXNlcjpwYXNz\n"auth": "Ym9iOmJvYg=="', mustNotContain: ['dXNlcjpwYXNz', 'Ym9iOmJvYg'] }, // pragma: allowlist secret
  { name: 'wifi and vpn pre-shared keys', input: '  psk="hunter2xyzhunter"\nPresharedKey = cHJlc2hhcmVkLWtleS12YWx1ZS0xMjM0NTY3ODkwMTI=', mustNotContain: ['hunter2xyzhunter', 'cHJlc2hhcmVk'] }, // pragma: allowlist secret
  // --- values ---
  { name: 'unquoted value with several words', input: 'passphrase: correct horse battery staple', mustNotContain: ['correct', 'horse', 'staple'] }, // pragma: allowlist secret
  { name: 'connection string password with a space', input: 'Server=db;User Id=sa;Password=conn pw;Database=x', mustNotContain: ['conn', 'pw;'] }, // pragma: allowlist secret
  { name: 'array under a sensitive key', input: '{"api_keys": ["k1abcdef", "k2abcdef"]}', mustNotContain: ['k1abcdef', 'k2abcdef'] }, // pragma: allowlist secret
  { name: 'object under a sensitive key', input: '{"secret": {"value": "x1y2z3"}, "n": 1}', mustNotContain: ['x1y2z3'] }, // pragma: allowlist secret
  { name: 'placeholder with a tail glued to it', input: 'password=[redacted]hunter2xyz', mustNotContain: ['hunter2xyz'] }, // pragma: allowlist secret
  { name: 'no-break space after the separator', input: 'password: hunter2xyz', mustNotContain: ['hunter2xyz'] }, // pragma: allowlist secret
  { name: 'fullwidth colon', input: 'password： hunter2xyz', mustNotContain: ['hunter2xyz'] }, // pragma: allowlist secret
  { name: 'zero-width space inside the name', input: 'pass​word: hunter2xyz', mustNotContain: ['hunter2xyz'] }, // pragma: allowlist secret
  { name: 'url with json-escaped slashes', input: '{"url":"https:\\/\\/bob:hunter2xyz@host\\/x"}', mustNotContain: ['hunter2xyz'] }, // pragma: allowlist secret
  // --- headers ---
  { name: 'authorization array', input: '{"authorization":["Bearer xyzxyzxyz"],"msg":"ok"}', mustNotContain: ['xyzxyzxyz'] }, // pragma: allowlist secret
  { name: 'go header map', input: 'map[Authorization:[Bearer xyzxyzxyz] User-Agent:[curl]]', mustNotContain: ['xyzxyzxyz'] }, // pragma: allowlist secret
  // --- token formats ---
  { name: 'vault tokens', input: 'vault login hvs.CAESIJlWQabcdefghijklmnopqrstuvwxyz0123456789 hvb.AAAAAQabcdefghijklmnopqrstuvwxyz hvr.abcdefghijklmnopqrstuvwxyz', mustNotContain: ['hvs.CAESIJ', 'hvb.AAAAAQ', 'hvr.abcdef'] }, // pragma: allowlist secret
  { name: 'slack app token and age key', input: 'xapp-1-A01234567-1234567890123-abcdef0123456789abcdef0123456789\nAGE-SECRET-KEY-1QYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSXXXXXX', mustNotContain: ['xapp-1-A01', 'AGE-SECRET-KEY-1Q'] }, // pragma: allowlist secret
  { name: 'notion, terraform cloud and twilio', input: 'secret§_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg\nabcdefghij1234.atlasv1.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghijklmnopqrstuv\nSKabcdef0123456789abcdef0123456789', mustNotContain: ['secret§_AbCdEf', 'atlasv1.AbCdEf', 'SKabcdef0123'] }, // pragma: allowlist secret
  { name: 'aws text output row', input: 'CREDENTIALS\tASIA§IOSFODNN7EXAMPLE\t2026-10-11T13:00:00+00:00\twJalr§XUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\tFwoGZXIvYXdzEBYaDExampleSessionTokenValue0123456789', mustNotContain: ['wJalr§XUtnFEMI', 'FwoGZXIvYXdz'] }, // pragma: allowlist secret
  // --- command lines ---
  { name: 'curl -u bundled with other short flags', input: 'curl -sSu bob:hunter2xyz https://example.com/api\ncurl -fsSLu bob:hunter3xyz https://example.com', mustNotContain: ['hunter2xyz', 'hunter3xyz'] }, // pragma: allowlist secret
  { name: 'curl -u with the user attached', input: 'curl -ubob:hunter2xyz https://example.com/api', mustNotContain: ['hunter2xyz'] }, // pragma: allowlist secret
  { name: 'mongosh, sqlcmd and zip passwords', input: 'mongosh --host h -u admin -p hunter2xyz --authenticationDatabase admin\nsqlcmd -S host -U sa -P Hunter3xyz -Q "select 1"\nzip -P hunter4xyz out.zip file', mustNotContain: ['hunter2xyz', 'Hunter3xyz', 'hunter4xyz'] }, // pragma: allowlist secret
  { name: 'password flags of more tools', input: 'cqlsh -u cass -p hunter5xyz\naz login -u a -p hunter6xyz\nipmitool -H h -U u -P hunter7xyz\nmosquitto_pub -P hunter8xyz -t x\n7z a -phunter9xyz a.7z f\nssh-keygen -N hunterAxyz -f k\nopenssl enc -k hunterBxyz\nhydra -l a -p hunterCxyz h ssh\nxfreerdp /v:h /u:a /p:hunterDxyz\nhttp -a user:hunterExyz GET x', mustNotContain: ['hunter5xyz', 'hunter6xyz', 'hunter7xyz', 'hunter8xyz', 'hunter9xyz', 'hunterAxyz', 'hunterBxyz', 'hunterCxyz', 'hunterDxyz', 'hunterExyz'] }, // pragma: allowlist secret
  { name: 'single-dash long options', input: 'Connect-AzAccount -Username bob -Password hunter2xyz\nkeytool -list -keystore ks.jks -storepass changeit', mustNotContain: ['hunter2xyz', 'changeit'] }, // pragma: allowlist secret
  { name: 'flags written with underscores or camel case', input: 'tool --db_password hunter2xyz --dbPassword hunter3xyz --password-hash hunter4xyz --credentials hunter5xyz --auth admin:hunter6xyz', mustNotContain: ['hunter2xyz', 'hunter3xyz', 'hunter4xyz', 'hunter5xyz', 'hunter6xyz'] }, // pragma: allowlist secret
  { name: 'mysql -p after a quoted semicolon', input: 'mysql -e "select 1; select 2" -uroot -phunter2xyz\nmysql -uroot -e "use x; show tables" -phunter3xyz', mustNotContain: ['hunter2xyz', 'hunter3xyz'] }, // pragma: allowlist secret
  { name: 'mysql -p after a long list of options', input: `mysqldump ${'--ignore-table=db.table_name '.repeat(18)}-uroot -phunter2xyz`, mustNotContain: ['hunter2xyz'] }, // pragma: allowlist secret
  { name: 'sqlplus user/password@db', input: 'sqlplus system/Hunter2xyz@//host:1521/XE', mustNotContain: ['Hunter2xyz'] }, // pragma: allowlist secret
  { name: 'az keyvault secret show', input: '{\n  "attributes": {"enabled": true},\n  "id": "https://v.vault.azure.net/secrets/dbpw/abc",\n  "kid": null,\n  "name": "dbpw",\n  "tags": {},\n  "value": "hunter2xyz"\n}', mustNotContain: ['hunter2xyz'] }, // pragma: allowlist secret
  { name: 'nmcli wireless psk and ssh-keygen passphrases', input: '802-11-wireless-security.psk: hunter4xyzhunter\nssh-keygen -p -P oldpw1x -N newpw2x -f k', mustNotContain: ['hunter4xyzhunter', 'oldpw1x', 'newpw2x'] }, // pragma: allowlist secret
  { name: 'mongodump and mongosh in a container', input: 'mongodump -h x -u a -p hunter2xyz\ndocker run --rm mongo mongosh -u a -p hunter5xyz', mustNotContain: ['hunter2xyz', 'hunter5xyz'] }, // pragma: allowlist secret
  // --- escaped line breaks (JSON-encoded multi-line strings) ---
  { name: 'escaped newline before a github token', input: '{"msg":"deploy failed\\nghp_abcdefghijklmnopqrstuvwxyz0123456789\\n"}', mustNotContain: ['ghp_abcdefghij'] }, // pragma: allowlist secret
  { name: 'escaped newlines around headers', input: '{"request":"POST /x HTTP/1.1\\nHost: h\\nAuthorization: Basic dXNlcjpTdXAzclNlY3JldFB3\\nCookie: sid=abc123def456ghi789\\n"}', mustNotContain: ['dXNlcjpTdXAzclNlY3JldFB3', 'abc123def456ghi789'] }, // pragma: allowlist secret
  { name: 'escaped newlines in an embedded script', input: '{"script":"#!/bin/sh\\ncurl -u bob:hunter2xyz https://x\\nmysql -u root -phunter2xyz db\\n"}', mustNotContain: ['hunter2xyz'] }, // pragma: allowlist secret
  { name: 'escaped newline before bearer and aws key id', input: '{"out":"ok\\nBearer abc123def456ghi789\\nAKIA§IOSFODNN7EXAMPLE\\n"}', mustNotContain: ['abc123def456ghi789', 'AKIA§IOSFODNN7EXAMPLE'] }, // pragma: allowlist secret
  { name: 'escaped crlf before a short name', input: '{"o":"a\\r\\npw=hunter2xyz"}', mustNotContain: ['hunter2xyz'] }, // pragma: allowlist secret
  { name: 'escaped tab before a long flag', input: '{"o":"a\\t--password hunter3xyz"}', mustNotContain: ['hunter3xyz'] }, // pragma: allowlist secret
  { name: 'escaped newline before sshpass', input: '{"o":"a\\nsshpass -p hunter4xyz ssh h"}', mustNotContain: ['hunter4xyz'] }, // pragma: allowlist secret
  // --- unquoted values with spaces ---
  { name: 'unquoted env value with spaces', input: 'SECRET_PHRASE=correct horse battery staple\nHOME=/root\n', mustNotContain: ['correct', 'horse', 'staple'] }, // pragma: allowlist secret
  { name: 'unquoted api key with spaces', input: 'API_KEY=abc def ghi\n', mustNotContain: ['abc def', 'ghi'] }, // pragma: allowlist secret
  { name: 'unquoted colon value with spaces', input: 'password:Zq7vK2mP x9LwRt4n second\nnext: 1', mustNotContain: ['Zq7vK2mP', 'x9LwRt4n', 'second'] }, // pragma: allowlist secret
  // --- Azure access keys ---
  { name: 'azure primaryKey and secondaryKey', input: '{\n  "primaryKey": "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjK=",\n  "secondaryKey": "ZyCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjK="\n}', mustNotContain: ['AbCdEfGhIjKlMnOp', 'ZyCdEfGhIjKlMnOp'] }, // pragma: allowlist secret
  { name: 'azure key1 and key2', input: '{\n  "key1": "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjK=",\n  "key2": "ZyCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjK="\n}', mustNotContain: ['AbCdEfGhIjKlMnOp', 'ZyCdEfGhIjKlMnOp'] }, // pragma: allowlist secret
  // --- cloud CLI output shapes ---
  { name: 'az storage account keys list', input: '[\n  {\n    "creationTime": "2024-01-01T00:00:00+00:00",\n    "keyName": "key1",\n    "permissions": "FULL",\n    "value": "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjK=="\n  }\n]', mustNotContain: ['AbCdEfGhIjKlMnOp'] }, // pragma: allowlist secret
  { name: 'az webapp appsettings with a member between name and value', input: '[\n  {\n    "name": "DB_PASSWORD",\n    "slotSetting": false,\n    "value": "Sup3rSecretPw"\n  }\n]', mustNotContain: ['Sup3rSecretPw'] }, // pragma: allowlist secret
  { name: 'aws output table with border bars', input: '||  AccessKeyId     |  AKIA§IOSFODNN7EXAMPLE     ||\n||  SecretAccessKey |  wJalr§XUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY  ||\n', mustNotContain: ['AKIA§IOSFODNN7EXAMPLE', 'wJalr§XUtnFEMI'] }, // pragma: allowlist secret
  { name: 'aws configure set', input: 'aws configure set aws_secret_access_key wJalr§XUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\naws configure set aws_session_token FwoGZXIvYXdzEBYaDHqa0APabcdef --profile p\n', mustNotContain: ['wJalr§XUtnFEMI', 'FwoGZXIvYXdzEBYaDHqa0APabcdef'] }, // pragma: allowlist secret
  // --- password hashes ---
  { name: 'shadow sha512 and yescrypt', input: 'root:$6$salt1234$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz01:19000:0:99999:7:::\nbob:$y$j9T$abcdefghijklmnopqrstu/$ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq:19000:0:99999:7:::', mustNotContain: ['abcdefghijklmnopqrstuvwxyzABCDEF', 'j9T$'] }, // pragma: allowlist secret
  { name: 'htpasswd apr1 and bcrypt', input: 'bob:$apr1$abcdefgh$ABCDEFGHIJKLMNOPQRSTUV\nalice:$2y$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234', mustNotContain: ['ABCDEFGHIJKLMNOPQRSTUV', 'abcdefghijklmnopqrstuu'] }, // pragma: allowlist secret
  { name: 'ntlm pair and ldap ssha', input: 'bob:1001:aad3b435b51404eeaad3b435b51404ee:8846f7eaee8fb117ad06bdd830b7586c:::\nuserPassword: {SSHA}abcdefghijkl==', mustNotContain: ['aad3b435b51404ee', '8846f7eaee8fb117', 'abcdefghijkl'] }, // pragma: allowlist secret
  // --- Authorization with = or a call ---
  { name: 'powershell hashtable authorization', input: '$h = @{Authorization="Basic dXNlcjpTdXAzclNlY3JldFB3"}', mustNotContain: ['dXNlcjpTdXAzclNlY3JldFB3'] }, // pragma: allowlist secret
  { name: 'powershell spaced authorization', input: 'Invoke-RestMethod -Uri https://x -Headers @{ Authorization = "Basic dXNlcjpTdXAzclNlY3JldFB3" }', mustNotContain: ['dXNlcjpTdXAzclNlY3JldFB3'] }, // pragma: allowlist secret
  { name: 'go Header.Set authorization', input: 'req.Header.Set("Authorization", "Basic dXNlcjpTdXAzclNlY3JldFB3")', mustNotContain: ['dXNlcjpTdXAzclNlY3JldFB3'] }, // pragma: allowlist secret
  // --- bearer ---
  { name: 'bearer with an all-lowercase token', input: 'Bearer abcdefghijklmnop', mustNotContain: ['abcdefghijklmnop'] }, // pragma: allowlist secret
  { name: 'bearer lowercase in a command', input: 'echo bearer hunterxyzabc', mustNotContain: ['hunterxyzabc'] }, // pragma: allowlist secret
  // --- yaml block scalars ---
  { name: 'yaml block scalar under a secret key', input: 'secret: |\n  line1secretvalue\n  line2secretvalue\nother: x\n', mustNotContain: ['line1secretvalue', 'line2secretvalue'] }, // pragma: allowlist secret
  { name: 'yaml folded scalar with a chomping indicator', input: 'password: >-\n  line1secretvalue\n  line2secretvalue\n', mustNotContain: ['line1secretvalue', 'line2secretvalue'] }, // pragma: allowlist secret
  { name: 'yaml tagged block scalar', input: 'db_pass: !vault |\n  $ANSIBLE_VAULT;1.1;AES256\n  3566366236333936646230343037623437356233353230356666363335626466\nnext: 1', mustNotContain: ['ANSIBLE_VAULT', '35663662363339'] }, // pragma: allowlist secret
  { name: 'yaml block scalar in a list item', input: 'items:\n  - token: |\n      line1secretvalue\n      line2secretvalue\n  - x: 1', mustNotContain: ['line1secretvalue', 'line2secretvalue'] }, // pragma: allowlist secret
];
const SECRET_CASES: SecretCase[] = RAW_SECRET_CASES.map((c) => ({
  name: c.name,
  input: unmark(c.input),
  mustNotContain: c.mustNotContain.map(unmark),
}));

// Text that must come out exactly as it went in.
const RAW_CLEAN_SAMPLES: Array<{ name: string; text: string }> = [
  { name: 'mkdir -p', text: 'mkdir -p /tmp/x' },
  { name: 'ssh -p', text: 'ssh -p 2222 host' },
  { name: 'docker run -p', text: 'docker run -d -p 80:80 nginx' },
  { name: 'mysql with a plain -p', text: 'mysql -u root -p mydb' },
  { name: 'mysqldump with a plain -p', text: 'mysqldump -u root -p --all-databases' },
  { name: 'curl -u without a colon', text: 'curl -u alice https://example.com' },
  { name: 'docker run -u uid:gid', text: 'docker run -u 1000:1000 --user nobody:nogroup img' },
  { name: 'sshpass then ssh -p port', text: 'sshpass -f /root/.pw ssh -p 2222 host' },
  { name: 'docker run -p after a docker login', text: 'docker login reg.example.com && docker run -p 8080:80 img' },
  { name: 'openssl pass from env or file', text: 'openssl enc -passin env:PW -passout file:/tmp/pw' },
  { name: 'password-file and password-stdin flags', text: 'docker login --password-stdin --username bob; tool --password-file /etc/pw --token-file /run/t' },
  { name: 'no-password flag', text: 'psql --no-password -h db' },
  { name: 'the word token in prose', text: 'The token was refreshed and the password policy was updated; enter your pin to continue.' },
  { name: 'prompt without a value', text: 'Enter passphrase for key /home/u/.ssh/id_ed25519: \nPassword:\n' },
  { name: 'ls -la', text: 'total 32\ndrwxr-xr-x  5 user user 4096 Oct 10 12:00 .\ndrwxr-xr-x 20 root root 4096 Oct  1 09:00 ..\n-rw-------  1 user user 1675 Oct  2 08:30 id_rsa\n-rw-r--r--  1 user user  401 Oct  2 08:30 id_rsa.pub\n-rwxr-xr-x  1 user user  220 Oct  1 09:00 .bash_logout' },
  { name: 'df -h', text: 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1        50G   20G   28G  42% /\ntmpfs           2.0G     0  2.0G   0% /dev/shm' },
  { name: 'ps aux', text: 'USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND\nroot         1  0.0  0.1 168936 11892 ?        Ss   Oct01   0:09 /sbin/init\nuser      4242  0.3  1.2 987654 98765 pts/0    Sl+  12:00   0:07 node server.js --port 3000' },
  { name: 'top', text: 'top - 12:00:01 up 10 days,  3:01,  2 users,  load average: 0.15, 0.10, 0.09\nTasks: 123 total,   1 running, 122 sleeping,   0 stopped,   0 zombie\n%Cpu(s):  1.0 us,  0.5 sy,  0.0 ni, 98.3 id,  0.2 wa,  0.0 hi,  0.0 si,  0.0 st\nMiB Mem :   7940.1 total,   1234.5 free,   2345.6 used,   4360.0 buff/cache' },
  { name: 'nginx access log', text: '203.0.113.7 - - [10/Oct/2026:13:55:36 +0000] "GET /index.html?page=2 HTTP/1.1" 200 2326 "https://example.com/" "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"\n203.0.113.8 - - [10/Oct/2026:13:55:37 +0000] "POST /api/token/refresh HTTP/1.1" 401 57 "-" "curl/8.5.0"' },
  { name: 'git log', text: 'commit 3f2a1b4c5d6e7f8091a2b3c4d5e6f708192a3b4c\nAuthor: Jane Doe <jane@example.com>\nDate:   Mon Oct 5 10:00:00 2026 +0200\n\n    fix: refresh the token before it expires\n\n3f2a1b4 (HEAD -> main) fix: refresh the token before it expires' },
  { name: 'json without sensitive keys', text: '{"name": "web", "replicas": 3, "ports": [80, 443], "image": "nginx:1.27", "env": {"LOG_LEVEL": "info"}}' },
  { name: 'sha256sum output', text: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  empty.txt\n9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08  test.txt' }, // pragma: allowlist secret
  { name: 'uuids', text: 'id=123e4567-e89b-12d3-a456-426614174000 request 550e8400-e29b-41d4-a716-446655440000' }, // pragma: allowlist secret
  { name: 'docker image digest', text: 'nginx@sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08\nDigest: sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' }, // pragma: allowlist secret
  { name: 'public ssh keys', text: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl user@host\nssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC7 user@host\nsk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29t user@host' }, // pragma: allowlist secret
  { name: 'certificate', text: '-----BEGIN CERTIFICATE-----\nMIIDdzCCAl+gAwIBAgIEAgAAuTANBgkqhkiG9w0BAQUFADBaMQswCQYDVQQGEwJJ\n-----END CERTIFICATE-----' }, // pragma: allowlist secret
  { name: 'base64 encoded certificate', text: 'ca.crt: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSURkekNDQWwrZ0F3SUJBZ0lFQWdBQXVUQU5CZ2txaGtpRzl3MEJBUVVGQURCYU1Rc3dDUVlEVlFRR0V3SkoK' }, // pragma: allowlist secret
  { name: 'ordinary words that contain pin, pass, auth', text: 'author: bob\ncompass=north\nbypass=true\npassenger: 4\nmapping: x\nspinner=1\nopinion: none\nsecretary: Jane\ntokenizer: whitespace' },
  { name: 'shell working directory', text: 'PWD=/home/user/project\nOLDPWD=/tmp' },
  { name: 'host name that starts with token', text: 'connect token.example.com:443 secret.example.org:8080 auth-token-service.default.svc:80' },
  { name: 'auth flag and value', text: 'auth: true\nauth=basic' },
  { name: 'sk- in an ordinary word', text: 'sk-learn and disk-usage and the task-runner-service-for-everyone' },
  { name: 'aws region and bucket', text: 's3://my-bucket/path/key.txt arn:aws:s3:::my-bucket us-east-1' },
  { name: 'url without userinfo', text: 'https://example.com:8443/path?x=1&y=2 ssh://git@github.com/org/repo.git https://user@example.com/' },
  { name: 'ssh option PasswordAuthentication', text: 'ssh -o PasswordAuthentication=no user@host\nPermitEmptyPasswords no\nPasswordAuthentication yes' },
  { name: 'passwd success message', text: 'passwd: all authentication tokens updated successfully.' },
  { name: 'declare -x PWD', text: 'declare -x PWD="/home/bob"\ndeclare -x OLDPWD="/tmp"' },
  { name: 'Bearer in prose', text: 'using Bearer authentication' },
  { name: 'secrets_dir and token_file settings', text: 'secrets_dir: /etc/secrets\ntoken_file: /var/run/secrets/token\npassword_policy: strict' },
  { name: 'curl flags that are not credentials', text: 'curl -sSL https://example.com/install.sh | sh\ncurl -fsSL -o out.tgz https://example.com/a.tgz\ncurl -u alice https://example.com' },
  { name: 'ssh-keygen with an empty passphrase', text: 'ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519' },
  { name: 'docker run with a container called mongo', text: 'docker run -d --name mongo -p 27017:27017 mongo\ndocker run -d --name cass -p 9042:9042 cassandra' },
  { name: 'mongosh without a password', text: 'mongosh --host db --port 27017 -u admin' },
  { name: 'kubernetes env entries that are not secrets', text: 'env:\n- name: LOG_LEVEL\n  value: info\n- name: DB_PASSWORD\n  valueFrom:\n    secretKeyRef:\n      key: password\n      name: db' },
  { name: 'kubectl configmap data', text: 'apiVersion: v1\ndata:\n  config.yaml: bG9nOiBpbmZv\n  DATABASE_HOST: ZGIuaW50ZXJuYWw=\nkind: ConfigMap\nmetadata:\n  name: app' },
  { name: 'kubeadm token table header', text: 'TOKEN                     TTL   EXPIRES                USAGES' },
  { name: 'prose lines that start with a keyword', text: 'Password policy was updated\nToken refreshed\nSecret garden' },
  { name: 'key names that are not credentials', text: 'primary_key: id\nsort_key=created_at\npublic_key: ssh-rsa\ns3_key: path/to/object.txt' },
  { name: 'authorization header with a null', text: '{"level":"info","Authorization":null,"msg":"request","path":"/health","status":200}' },
  { name: 'go map without a credential', text: 'map[Accept:[*/*] User-Agent:[curl]]' },
  { name: 'ordinary key value table', text: 'Key         Value\n---         -----\nname        web\nreplicas    3' },
  { name: 'package listings with secret-like names', text: 'Package          Version\n---------------- -------\ndetect-secrets   1.5.0\nsecretstorage    3.3.3\nlibsecret-1-0    0.20.5' },
  { name: 'login.defs limits', text: 'PASS_MAX_DAYS\t99999\nPASS_MIN_DAYS\t0\nPASS_WARN_AGE\t7' },
  { name: 'prose about a username and password', text: 'Takes a string of the form username:password and returns the username and password decoded.' },
  { name: 'declarations in code', text: 'const key = modelKey(model);\nconst hotkey = bindings.get(name);' },
  { name: 'kubectl describe environment', text: 'Environment:\n  DB_PASSWORD:  <set to the key \'password\' in secret \'db-secret\'>  Optional: false\n  LOG_LEVEL:    info' },
  { name: 'prompts and labels without a value', text: 'Enter Password: \n[sudo] password for bob: \nPassword for \'https://user@github.com\': \nToken expires: 2026-10-11T10:00:00Z\nToken type: Bearer' },
  { name: 'empty and short inputs', text: '' },
  { name: 'primary_key and key1 with plain values', text: 'primary_key: id\nkey1: abc\nprimaryKey: 6f1c1c1e-0a0b-4c4d-8e8f-123456789abc\n"key2": "x"' }, // pragma: allowlist secret
  { name: 'header names in a list', text: 'Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With\n["Content-Type", "Authorization", "X-Foo"]' },
  { name: 'bearer in prose', text: 'using Bearer authentication\nAuthorization header scheme: Bearer token\nsend it as Bearer credentials' },
  { name: 'dollar signs and hex pairs that are not hashes', text: 'cost $5$ per item, $1$ofthem\nid 123e4567e89b12d3a456426614174000 and 550e8400e29b41d4a716446655440000\ntoken_count: 12 of 40' }, // pragma: allowlist secret
  { name: 'yaml block scalar under an ordinary key', text: 'description: |\n  first line\n  second line\nname: x\n' },
  { name: 'escaped newlines in ordinary json logs', text: '{"msg":"started\\nlistening on :8080\\nready in 12ms\\n","level":"info"}' },
  { name: 'aws configure set with a region', text: 'aws configure set region eu-north-1\naws configure set output json' },
];
const CLEAN_SAMPLES = RAW_CLEAN_SAMPLES.map((c) => ({ name: c.name, text: unmark(c.text) }));

describe('maskSecrets', () => {
  describe('secrets are masked', () => {
    it.each(SECRET_CASES)('$name', ({ input, mustNotContain }) => {
      const { text, count } = maskSecretsCounted(input);
      for (const secret of mustNotContain) expect(text, `output still holds ${secret}`).not.toContain(secret);
      expect(text).toContain(REDACTED);
      expect(count).toBeGreaterThan(0);
    });

    it('every case is also masked when it sits in the middle of other output', () => {
      for (const { input, mustNotContain } of SECRET_CASES) {
        const text = maskSecrets(`$ echo start\nsome output\n${input}\nmore output\n$ `);
        for (const secret of mustNotContain) expect(text, `output still holds ${secret}`).not.toContain(secret);
      }
    });
  });

  describe('ordinary terminal output is left alone', () => {
    it.each(CLEAN_SAMPLES)('$name', ({ text }) => {
      expect(maskSecretsCounted(text)).toEqual({ text, count: 0 });
    });
  });

  describe('shape of the output', () => {
    const EXACT: Array<[string, string]> = [
      ['MYSQL_PASSWORD=hunter2', 'MYSQL_PASSWORD=[redacted]'], // pragma: allowlist secret
      ['{"o":"ok\\nBearer abc123def456ghi789\\n"}', '{"o":"ok\\nBearer [redacted]\\n"}'], // pragma: allowlist secret
      ['req.Header.Set("Authorization", "Basic dXNlcjpTdXAzclNlY3JldFB3")', 'req.Header.Set("Authorization", "Basic [redacted]")'], // pragma: allowlist secret
      ['SECRET_PHRASE=correct horse\nHOME=/root', 'SECRET_PHRASE=[redacted]\nHOME=/root'], // pragma: allowlist secret
      ['secret: |\n  line1\n  line2\nother: x', 'secret: [redacted]\nother: x'], // pragma: allowlist secret
      ['Password: hunter2', 'Password: [redacted]'], // pragma: allowlist secret
      ['export API_KEY="two words" && ls', 'export API_KEY=[redacted] && ls'], // pragma: allowlist secret
      ['{"password": "two words", "next": 1}', '{"password": [redacted], "next": 1}'], // pragma: allowlist secret
      ['{"pin": 1234}', '{"pin": [redacted]}'], // pragma: allowlist secret
      ['f(password=hunter2)', 'f(password=[redacted])'], // pragma: allowlist secret
      ['a=1; token=abc; b=2', 'a=1; token=[redacted]; b=2'], // pragma: allowlist secret
      ['Authorization: Bearer abcdefghijklmnop', 'Authorization: Bearer [redacted]'], // pragma: allowlist secret
      ['Authorization: Basic dXNlcjpwdw==', 'Authorization: Basic [redacted]'], // pragma: allowlist secret
      ['Cookie: a=b; c=d', 'Cookie: [redacted]'], // pragma: allowlist secret
      ['curl -H "Authorization: Bearer abc.def" https://x', 'curl -H "Authorization: Bearer [redacted]" https://x'], // pragma: allowlist secret
      ["curl -H 'X-Api-Key: abc def' https://x", "curl -H 'X-Api-Key: [redacted]' https://x"], // pragma: allowlist secret
      ['https://bob:hunter2@example.com/x', 'https://bob:[redacted]@example.com/x'], // pragma: allowlist secret
      ['redis://:hunter2@host:6379', 'redis://:[redacted]@host:6379'], // pragma: allowlist secret
      ['curl -u bob:hunter2 https://x', 'curl -u bob:[redacted] https://x'], // pragma: allowlist secret
      ['mysql -uroot -phunter2 db', 'mysql -uroot -p[redacted] db'], // pragma: allowlist secret
      ['sshpass -p hunter2 ssh -p 22 h', 'sshpass -p [redacted] ssh -p 22 h'], // pragma: allowlist secret
      ['openssl x -passin pass:hunter2', 'openssl x -passin pass:[redacted]'], // pragma: allowlist secret
      ['tool --password hunter2 --verbose', 'tool --password [redacted] --verbose'], // pragma: allowlist secret
      ['tool --token --verbose', 'tool --token --verbose'],
      ['https://h/p?a=1&sig=abc%3D&b=2', 'https://h/p?a=1&sig=[redacted]&b=2'], // pragma: allowlist secret
      ['AccountKey=abc==;EndpointSuffix=x', 'AccountKey=[redacted];EndpointSuffix=x'], // pragma: allowlist secret
      ['GET /cb?state=ok&password=qspw1&next=%2Fhome#frag', 'GET /cb?state=ok&password=[redacted]&next=%2Fhome#frag'], // pragma: allowlist secret
      ['Server=db;User Id=sa;Password=pw 1;Database=x', 'Server=db;User Id=sa;Password=[redacted];Database=x'], // pragma: allowlist secret
      ["IDENTIFIED BY 'x y'", 'IDENTIFIED BY [redacted]'], // pragma: allowlist secret
      ['GITHUB_TOKEN=ghp_1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P7q8R', 'GITHUB_TOKEN=[redacted]'], // pragma: allowlist secret
      ['before\n-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\nafter', 'before\n[redacted]\nafter'], // pragma: allowlist secret
      ['cut\nabc\n-----END RSA PRIVATE KEY-----\nafter', '[redacted]\nafter'], // pragma: allowlist secret
      ['-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\ntrailing\nmore', '[redacted]\ntrailing\nmore'], // pragma: allowlist secret
      ['machine api.github.com\n  login bob\n  password hunter2xyz', 'machine api.github.com\n  login bob\n  password [redacted]'], // pragma: allowlist secret
      ['curl -sSu bob:hunter2xyz https://example.com/api', 'curl -sSu bob:[redacted] https://example.com/api'], // pragma: allowlist secret
      ['mysql -e "select 1; select 2" -uroot -phunter2xyz', 'mysql -e "select 1; select 2" -uroot -p[redacted]'], // pragma: allowlist secret
      ['sqlplus system/Hunter2xyz@//host:1521/XE', 'sqlplus system/[redacted]@//host:1521/XE'], // pragma: allowlist secret
      ['BASIC_AUTH=bob:hunter2xyz', 'BASIC_AUTH=[redacted]'], // pragma: allowlist secret
      ['passphrase: correct horse battery staple', 'passphrase: [redacted]'], // pragma: allowlist secret
      ['{"api_keys": ["k1abcdef", "k2abcdef"]}', '{"api_keys": [redacted]}'], // pragma: allowlist secret
      ['{"secret": {"value": "x1y2z3"}, "n": 1}', '{"secret": [redacted], "n": 1}'], // pragma: allowlist secret
      ['password=[redacted]hunter2xyz', 'password=[redacted]'], // pragma: allowlist secret
      ['env:\n- name: DB_PASSWORD\n  value: hunter2xyz\n- name: LOG_LEVEL\n  value: info', 'env:\n- name: DB_PASSWORD\n  value: [redacted]\n- name: LOG_LEVEL\n  value: info'], // pragma: allowlist secret
      ['SecretID:         0000-1111\nPassword:         hunter2xyz', 'SecretID:         [redacted]\nPassword:         [redacted]'], // pragma: allowlist secret
      ['{"level":"info","Authorization":"Bearer abcdefgh1","msg":"request"}', '{"level":"info","Authorization":"Bearer [redacted]","msg":"request"}'], // pragma: allowlist secret
      ['map[Authorization:[Bearer xyzxyzxyz] User-Agent:[curl]]', 'map[Authorization:[redacted] User-Agent:[curl]]'], // pragma: allowlist secret
      ['password: hunter2xyz', 'password: [redacted]'], // pragma: allowlist secret
      ['{"url":"https:\\/\\/bob:hunter2xyz@host\\/x"}', '{"url":"https:\\/\\/bob:[redacted]@host\\/x"}'], // pragma: allowlist secret
    ];

    it.each(EXACT)('%j', (input, expected) => {
      expect(maskSecrets(input)).toBe(expected);
    });

    it('keeps CRLF line endings around masked values', () => {
      expect(maskSecrets('PASSWORD=hunter2\r\nuser=bob\r\n')).toBe('PASSWORD=[redacted]\r\nuser=bob\r\n'); // pragma: allowlist secret
    });

    it('masks several key blocks and keeps the text between them', () => {
      const text = ['a', '-----BEGIN PRIVATE KEY-----', 'k1', '-----END PRIVATE KEY-----', 'b', '-----BEGIN PRIVATE KEY-----', 'k2', '-----END PRIVATE KEY-----', 'c'].join('\n'); // pragma: allowlist secret
      expect(maskSecretsCounted(text)).toEqual({ text: 'a\n[redacted]\nb\n[redacted]\nc', count: 2 });
    });

    it('masks a Secret manifest but not the other documents around it', () => {
      const text = 'kind: ConfigMap\ndata:\n  a: b\n---\napiVersion: v1\ndata:\n  tls.crt: Zm9v\n  token: YmFy\nkind: Secret\n---\nkind: ConfigMap\ndata:\n  c: d';
      expect(maskSecretsCounted(text)).toEqual({
        text: 'kind: ConfigMap\ndata:\n  a: b\n---\napiVersion: v1\ndata:\n  tls.crt: [redacted]\n  token: [redacted]\nkind: Secret\n---\nkind: ConfigMap\ndata:\n  c: d',
        count: 2,
      });
    });

    it('masks every Secret of a kubectl list and keeps the ConfigMaps', () => {
      const text = 'items:\n- apiVersion: v1\n  data:\n    a: Zm9v\n  kind: Secret\n- apiVersion: v1\n  data:\n    b: YmFy\n  kind: ConfigMap\n- apiVersion: v1\n  data:\n    c: YmF6\n  kind: Secret';
      expect(maskSecrets(text)).toBe('items:\n- apiVersion: v1\n  data:\n    a: [redacted]\n  kind: Secret\n- apiVersion: v1\n  data:\n    b: YmFy\n  kind: ConfigMap\n- apiVersion: v1\n  data:\n    c: [redacted]\n  kind: Secret');
    });

    it('keeps the lines after a mentioned BEGIN marker (grep output)', () => {
      const text = '$ grep -r "BEGIN RSA PRIVATE KEY" /home\n/home/a/id_rsa:-----BEGIN RSA PRIVATE KEY-----\n/home/b/k.pem:-----BEGIN RSA PRIVATE KEY-----\n$ ls\nfile1 file2'; // pragma: allowlist secret
      expect(maskSecretsCounted(text)).toEqual({
        text: '$ grep -r "BEGIN RSA PRIVATE KEY" /home\n/home/a/id_rsa:[redacted]\n/home/b/k.pem:[redacted]\n$ ls\nfile1 file2', // pragma: allowlist secret
        count: 2,
      });
    });

    it('keeps the output before an END marker that is only mentioned', () => {
      const text = '$ ls\nfile1 file2\n$ echo "-----END RSA PRIVATE KEY-----"\nafter'; // pragma: allowlist secret
      expect(maskSecrets(text)).toBe('$ ls\nfile1 file2\n$ echo "[redacted]"\nafter');
    });

    it('masks a key whose BEGIN line was cut off, back to the start of the text', () => {
      const text = 'rLx9QabcdefghijklmnopqrstuvwxyZ0123456789ABCD\nMIIEowIBAAKCAQEAabcdefghijklmnopqrstuvwxyz0123456789\n-----END RSA PRIVATE KEY-----\n$ ls'; // pragma: allowlist secret
      expect(maskSecrets(text)).toBe('[redacted]\n$ ls');
    });

    it('masks a key that is cut off at the end of the text and a log-prefixed key', () => {
      const body = 'MIIEowIBAAKCAQEAabcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH'; // pragma: allowlist secret
      expect(maskSecrets(`$ cat k\n-----BEGIN RSA PRIVATE KEY-----\n${body}\n${body}\n$ ls`)).toBe('$ cat k\n[redacted]\n$ ls'); // pragma: allowlist secret
      expect(maskSecrets(`2026-10-11 INFO -----BEGIN RSA PRIVATE KEY-----\n2026-10-11 INFO ${body}\n2026-10-11 INFO -----END RSA PRIVATE KEY-----\ndone`)).toBe('2026-10-11 INFO [redacted]\ndone'); // pragma: allowlist secret
    });

    it('keeps CRLF line endings around a masked key', () => {
      const body = 'MIIEowIBAAKCAQEAabcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH'; // pragma: allowlist secret
      expect(maskSecrets(`a\r\n-----BEGIN RSA PRIVATE KEY-----\r\n${body}\r\n-----END RSA PRIVATE KEY-----\r\nb`)).toBe('a\r\n[redacted]\r\nb'); // pragma: allowlist secret
    });

    it('lets an orphan end marker join the complete block right above it', () => {
      const text = ['-----BEGIN PRIVATE KEY-----', 'k1', '-----END PRIVATE KEY-----', 'middle', 'k2', '-----END PRIVATE KEY-----', 'tail'].join('\n'); // pragma: allowlist secret
      expect(maskSecretsCounted(text)).toEqual({ text: '[redacted]\ntail', count: 1 });
    });
  });

  describe('names that only contain a keyword inside an ordinary word', () => {
    it.each(['author', 'compass', 'bypass', 'passenger', 'mapping', 'spinner', 'opinion', 'pinned', 'tokenizer', 'secretary'])('%s', (word) => {
      for (const sep of ['=', ': ', ' = ']) {
        const text = `${word}${sep}value`;
        expect(maskSecrets(text)).toBe(text);
      }
    });
  });

  describe('properties', () => {
    it('is idempotent: masked text is returned unchanged with count 0', () => {
      const inputs = [...SECRET_CASES.map((c) => c.input), ...CLEAN_SAMPLES.map((c) => c.text)];
      for (const input of inputs) {
        const once = maskSecretsCounted(input);
        expect(maskSecretsCounted(once.text), JSON.stringify(input)).toEqual({ text: once.text, count: 0 });
      }
    });

    it('is idempotent on generated mixtures of secrets, delimiters and quotes', () => {
      const parts = [
        'password=', 'PASSWORD: ', '"password": ', "'token': ", 'Authorization: ', 'Bearer ', 'Cookie: ', 'curl -u ', 'mysql -p', '--password ', '--token=', 'https://', 'bob:pw@host',
        ':pw@', ' ', '\n', ';', ',', ')', '}', ']', '(', '{', '[', '&', '?', '"', "'", 'hunter2', 'two words', '[redacted]', 'sig=', 'login a password ', 'x',
        '<password>', '</password>', 'API_KEY=', 'AccountKey=', 'identified by ', "'pw'",
        '-----BEGIN PRIVATE KEY-----', '-----END PRIVATE KEY-----', // pragma: allowlist secret
      ];
      let seed = 20260811;
      const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
      for (let i = 0; i < 4000; i++) {
        let input = '';
        for (let j = 0, n = 1 + Math.floor(next() * 12); j < n; j++) input += parts[Math.floor(next() * parts.length)];
        const once = maskSecretsCounted(input);
        const twice = maskSecretsCounted(once.text);
        expect(twice, JSON.stringify(input)).toEqual({ text: once.text, count: 0 });
      }
    });

    it('counts every masked item once', () => {
      const sample = [
        unmark('export AWS_ACCESS_KEY_ID=AKIA§ABCDEFGHIJKLMNOP'), // pragma: allowlist secret
        'MYSQL_PASSWORD=hunter2', // pragma: allowlist secret
        'curl -H "Authorization: Bearer abcdefghijkl" https://bob:pw@example.com/x', // pragma: allowlist secret
        'GITHUB_TOKEN=ghp_1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P7q8R', // pragma: allowlist secret
        '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----', // pragma: allowlist secret
        'mysql -uroot -psecret1 db', // pragma: allowlist secret
        'plain line without secrets',
      ].join('\n');
      const { text, count } = maskSecretsCounted(sample);
      expect(count).toBe(7);
      expect(text.split(REDACTED).length - 1).toBe(7);
      expect(text).toContain('plain line without secrets');
    });

    it('does not count one secret twice when several rules see it', () => {
      expect(maskSecretsCounted('API_KEY=sk-AbCdEfGhIjKlMnOpQrStUvWxYz012345').count).toBe(1); // pragma: allowlist secret
      expect(maskSecretsCounted('Authorization: Bearer ghp_1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P7q8R').count).toBe(1); // pragma: allowlist secret
      expect(maskSecretsCounted('{"private_key": "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n"}').count).toBe(1); // pragma: allowlist secret
    });

    it('counts a secret whose region swallowed an existing placeholder', () => {
      expect(maskSecretsCounted('Cookie: sid=abc123; [redacted]')).toEqual({ text: 'Cookie: [redacted]', count: 1 }); // pragma: allowlist secret
      expect(maskSecretsCounted('Cookie: [redacted]')).toEqual({ text: 'Cookie: [redacted]', count: 0 });
    });

    it('does not truncate and keeps the text around secrets', () => {
      const filler = 'line of ordinary output\n'.repeat(5000);
      const text = maskSecrets(`${filler}PASSWORD=hunter2\n${filler}`); // pragma: allowlist secret
      expect(text).toBe(`${filler}PASSWORD=[redacted]\n${filler}`);
    });

    it('masks secrets that sit beyond the first 16000 characters', () => {
      const text = maskSecrets(`${'x'.repeat(20000)}\nAPI_KEY=late-secret-value`); // pragma: allowlist secret
      expect(text).not.toContain('late-secret-value');
    });

    it('runs in linear time on adversarial 1 MB inputs', () => {
      const size = 1024 * 1024;
      const rep = (unit: string) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
      const inputs = [
        'a'.repeat(size),
        '='.repeat(size),
        '-'.repeat(size),
        rep('password'),
        rep('password='),
        rep('password="a '),
        `-----BEGIN RSA PRIVATE KEY-----${'A'.repeat(size)}`, // pragma: allowlist secret
        rep('-----BEGIN '),
        rep('-----END '),
        rep('Authorization: '),
        rep('eyJ.'),
      ];
      const started = performance.now();
      for (const input of inputs) maskSecrets(input);
      expect(performance.now() - started).toBeLessThan(2000);
    });

    it('stays linear when every few characters start a match that is cut short', () => {
      // A value that is read to its end and then trimmed would make these quadratic
      const size = 512 * 1024;
      const rep = (unit: string) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
      const inputs = [rep('https://a:b@'), rep('x;Password=abc;y=1;'), rep('?token=a&x=1'), rep('auth=PWD=/'), rep('Cookie: [redacted]')];
      const started = performance.now();
      for (const input of inputs) maskSecrets(input);
      expect(performance.now() - started).toBeLessThan(2000);
    });

    it('stays linear on inputs that are full of matches', () => {
      const size = 128 * 1024;
      const rep = (unit: string) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
      const inputs = [
        rep('curl -u a:b '),
        rep('mysql -pa '),
        rep('mysql ; -pa'),
        rep('sshpass -p a ssh -p 1 '),
        rep('--token=a '),
        rep('-passin pass:a '),
        rep('password="a" '),
        rep('login a password b '),
        rep('Bearer abcdefghij '),
        rep(unmark('AKIA§ABCDEFGHIJKLMNOP ')), // pragma: allowlist secret
        rep('redis://:pw@h:1 '),
        rep('export API_KEY=a;'),
        rep('LS0tLS1CRUdJTi'),
      ];
      const started = performance.now();
      for (const input of inputs) maskSecrets(input);
      expect(performance.now() - started).toBeLessThan(2000);
    });
  });

  describe('new rules stay linear', () => {
    it('on adversarial 1 MB inputs for the escaped-break, hash, header, name/value and block scalar rules', () => {
      const size = 1024 * 1024;
      const rep = (unit: string) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
      const inputs = [
        rep('\\nPASSWORD=a'),
        rep('\\n\\r\\t'),
        rep('$6$abcdefgh'),
        rep('{SSHA}'),
        rep('aad3b435b51404eeaad3b435b51404ee:'),
        rep('("Authorization", '),
        rep('Authorization, '),
        rep('Authorization="'),
        rep('"name": "x", "a": 1, '),
        rep('"keyName": "a", '),
        rep('aws configure set '),
        rep('"primaryKey": "a", key1='),
        rep('password: |'),
        rep('key: !vault |\n  a\n'),
        rep('PASSWORD=a b c '),
      ];
      for (const input of inputs) {
        const started = performance.now();
        maskSecrets(input);
        expect(performance.now() - started, input.slice(0, 40)).toBeLessThan(1500);
      }
    });

    it('on a single long line that repeats private key markers', () => {
      const size = 1024 * 1024;
      const rep = (unit: string) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
      const inputs = [
        rep('-----BEGIN PRIVATE KEY-----'), // pragma: allowlist secret
        rep('-----END PRIVATE KEY-----'),
        rep('-----BEGIN PRIVATE KEY-----AAAAAAAAAAAAAAAAAAAA'), // pragma: allowlist secret
        rep('-----BEGIN PRIVATE KEY----- -----END PRIVATE KEY-----'), // pragma: allowlist secret
      ];
      const started = performance.now();
      for (const input of inputs) maskSecrets(input);
      expect(performance.now() - started).toBeLessThan(2000);
    });

    it('on a Secret manifest with 200000 entries (no stack overflow)', () => {
      const text = `kind: Secret\ndata:\n${' a: b\n'.repeat(200000)}`;
      expect(() => maskSecretsCounted(text)).not.toThrow();
      expect(maskSecrets(text)).not.toContain(': b');
    });
  });

  describe('log redaction', () => {
    it('redactString masks with the shared patterns and still truncates', () => {
      expect(redactString('x SSHS3_PROXY_PASSWORD=hunter2 y')).toBe('x SSHS3_PROXY_PASSWORD=[redacted] y'); // pragma: allowlist secret
      const long = redactString(`${'a'.repeat(3000)} token=abc`);
      expect(long.endsWith('…[truncated]')).toBe(true);
    });

    it('redactString masks a private key before it clips, so no tail of the key is left next to the marker', () => {
      const body = 'MIIEow0030AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/AbCdEfGhIjKlMnOpQr'; // pragma: allowlist secret
      for (let pad = 0; pad < 64; pad += 7) {
        const key = `${'x'.repeat(pad)}\n-----BEGIN RSA PRIVATE KEY-----\n${`${body}\n`.repeat(40)}-----END RSA PRIVATE KEY-----`; // pragma: allowlist secret
        const out = redactString(key);
        expect(out, `pad ${pad}`).not.toContain('MIIEow');
        expect(out).not.toContain('AbCdEfGh');
      }
      const long = redactString(`${'a'.repeat(3000)} password=hunter2`); // pragma: allowlist secret
      expect(long).not.toContain('hunter2');
      expect(long.endsWith('…[truncated]')).toBe(true);
    });
  });
});
