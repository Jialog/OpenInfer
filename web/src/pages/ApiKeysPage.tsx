import {useEffect, useState, type FormEvent, type ReactNode} from 'react';
import {describeError, type ApiError} from '@/api/errors';
import type {ApiKey, Catalog, ID} from '@/api/types';
import {ListRow, PageHeader} from '@/components/page';
import {Alert, AlertDescription} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardHeader, CardList} from '@/components/ui/card';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {Pill} from '@/components/ui/pill';
import {formatLocalTime, formatRelative} from '@/lib/format';
import {useAction} from '@/lib/useAction';
import {useStore} from './Workspace';


function validateName(name: string): string | null {
  if (!name.trim()) return 'Enter a name for the key.';
  if (name.length > 80) return 'Use at most 80 characters.';
  return null;
}

export function ApiKeysPage() {
  const {client, devices} = useStore();
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [certificatePath, setCertificatePath] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [listError, setListError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [created, setCreated] = useState<{api_key: ApiKey; secret: string} | null>(null);

  useEffect(() => {
    let current = true;
    setListError(null);
    client
      .get<{api_keys: ApiKey[]; certificate_path: string | null}>('/api-keys')
      .then((r) => {
        if (!current) return;
        setKeys(r.api_keys);
        setCertificatePath(r.certificate_path);
      })
      .catch((e) => current && setListError(e as ApiError));
    return () => {
      current = false;
    };
  }, [client, attempt]);

  // the model the examples name is the catalog's (the one /v1/models lists)
  useEffect(() => {
    client.get<Catalog>('/catalog').then(setCatalog).catch(() => setCatalog(null));
  }, [client]);

  const generate = useAction(async (keyName: string) => {
    const result = await client.post<{api_key: ApiKey; secret: string}>('/api-keys', {name: keyName});
    setCreated(result);
    setName('');
    setKeys((list) => [result.api_key, ...(list ?? []).filter((k) => k.id !== result.api_key.id)]);
  });
  const copy = useAction(() => navigator.clipboard.writeText(created?.secret ?? ''));

  function submit(event: FormEvent) {
    event.preventDefault();
    const problem = validateName(name);
    setNameError(problem);
    if (!problem) void generate.run(name);
  }

  const replace = (key: ApiKey) => setKeys((list) => (list ?? []).map((k) => (k.id === key.id ? key : k)));

  return (
    <>
      <PageHeader
        title="API keys"
        description="Programs use an API key to send requests to your running session through the OpenAI-compatible API. A key acts as you: anyone who has it can use your session."
      />
      <Card>
        <CardHeader title="Generate a key" description="Give each program its own key, so you can revoke one without stopping the others." />
        <CardContent className="flex flex-col gap-4">
          {created ? (
            <div className="flex flex-col gap-3 text-sm">
              <p>Key for <strong className="font-medium break-all">{created.api_key.name}</strong>. It is shown only once: copy it now. If it is lost, revoke it and generate another.</p>
              <code className="rounded-lg border bg-subtle px-3 py-2.5 font-mono text-[13px] break-all">{created.secret}</code>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" disabled={copy.pending} onClick={() => void copy.run()}>Copy key</Button>
                <Button variant="outline" onClick={() => setCreated(null)}>Done</Button>
              </div>
              {copy.error && <p className="text-xs text-destructive">Could not copy the key.</p>}
            </div>
          ) : (
            <form className="flex flex-col gap-3" onSubmit={submit}>
              <div className="flex flex-col gap-2">
                <Label htmlFor="key-name">Key name</Label>
                <Input id="key-name" value={name} placeholder="For example: laptop scripts" aria-invalid={nameError ? true : undefined}
                       onChange={(e) => {setName(e.target.value); setNameError(null);}} />
              </div>
              {nameError && <p className="text-sm text-destructive">{nameError}</p>}
              {generate.error && <Alert variant="destructive"><AlertDescription>{describeError(generate.error.body, devices)}</AlertDescription></Alert>}
              <Button type="submit" className="self-start" disabled={generate.pending}>Generate key</Button>
            </form>
          )}
        </CardContent>
      </Card>
      <Card data-testid="api-keys">
        <CardHeader title="Your keys" description="Newest first. A revoked key stays in the list; requests already running with it finish." />
        {listError && (
          <CardContent>
            <Alert variant="destructive">
              <AlertDescription>
                {describeError(listError.body, devices)}{' '}
                <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>Read the list again</Button>
              </AlertDescription>
            </Alert>
          </CardContent>
        )}
        {!listError && keys?.length === 0 && <CardContent><p className="text-sm text-muted-foreground">No keys yet.</p></CardContent>}
        {keys && keys.length > 0 && (
          <CardList>
            {keys.map((key) => <KeyRow key={key.id} apiKey={key} onRevoked={replace} />)}
          </CardList>
        )}
      </Card>
      <UsageCard certificatePath={certificatePath} catalog={catalog} />
    </>
  );
}

function KeyRow({apiKey, onRevoked}: {apiKey: ApiKey; onRevoked: (key: ApiKey) => void}) {
  const {client, devices} = useStore();
  const [confirming, setConfirming] = useState(false);
  const revoke = useAction(async (id: ID) => {
    const result = await client.post<{api_key: ApiKey}>(`/api-keys/${id}/revoke`, {});
    setConfirming(false);
    onRevoked(result.api_key);
  });
  const used = apiKey.last_used_at ? `Last used ${formatRelative(apiKey.last_used_at)}` : 'Never used';
  return (
    <ListRow
      title={apiKey.name}
      description={
        <>
          <span className="font-mono">{apiKey.hint.replace(/^oi_/, 'oi_…')}</span>
          {' · '}<span title={formatLocalTime(apiKey.created_at)}>{`Generated ${formatRelative(apiKey.created_at)}`}</span>
          {' · '}<span title={apiKey.last_used_at ? formatLocalTime(apiKey.last_used_at) : undefined}>{used}</span>
        </>
      }
      aside={apiKey.revoked_at
        ? <Pill tone="neutral" title={formatLocalTime(apiKey.revoked_at)}>Revoked</Pill>
        : !confirming && <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>Revoke</Button>}
    >
      {confirming && !apiKey.revoked_at && (
        <div className="flex flex-col gap-2.5 rounded-lg border bg-subtle px-3.5 py-3 text-sm">
          <p>Revoke this key? Programs using this key stop working; it cannot be turned back on.</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="destructive" disabled={revoke.pending} onClick={() => void revoke.run(apiKey.id)}>Revoke key</Button>
            <Button size="sm" variant="outline" onClick={() => setConfirming(false)}>Cancel</Button>
          </div>
          {revoke.error && <p className="text-xs text-destructive">{describeError(revoke.error.body, devices)}</p>}
        </div>
      )}
    </ListRow>
  );
}

function Example({title, children}: {title: string; children: string}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="text-[13px] font-medium text-muted-foreground">{title}</span>
      {/* Field names such as max_tokens are shown here on purpose; the screenshot leak check skips this block only. */}
      <pre data-leak-exempt="" className="overflow-x-auto rounded-lg border bg-subtle px-3 py-2.5 font-mono text-[13px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]"><code>{children}</code></pre>
    </div>
  );
}

function Fact({term, children}: {term: string; children: ReactNode}) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="min-w-0 font-mono text-[13px] [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function UsageCard({certificatePath, catalog}: {certificatePath: string | null; catalog: Catalog | null}) {
  const base = `${window.location.origin}/v1`;
  const model = catalog?.versions.find((v) => v.role === 'service')?.model ?? '<model>';
  const context = catalog?.models[model]?.context_length;
  const curl = `curl --cacert tls.crt ${base}/chat/completions \\
  -H "Authorization: Bearer $OPENINFER_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${model}", "messages": [{"role": "user", "content": "Hello"}]}'`;
  const python = `import os
from openai import OpenAI

client = OpenAI(base_url="${base}", api_key=os.environ["OPENINFER_API_KEY"])
reply = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "Hello"}],
)
message = reply.choices[0].message
print(message.reasoning_content)  # the thinking
print(message.content)            # the answer`;
  return (
    <Card data-testid="api-usage">
      <CardHeader title="Use the API" description="Any program that speaks the OpenAI chat completions API can use OpenInfer by changing its base address and key." />
      <CardContent className="flex flex-col gap-5 text-sm">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-lg border bg-subtle px-3.5 py-3">
          <Fact term="Base address">{base}</Fact>
          <Fact term="Model">{model}</Fact>
          <Fact term="Key">Authorization: Bearer &lt;your key&gt;</Fact>
        </dl>
        <p className="text-muted-foreground">
          The server uses a certificate of its own ({certificatePath
            ? <><span className="font-mono [overflow-wrap:anywhere]">{certificatePath}</span> on the machine that runs the server</>
            : <><span className="font-mono">tls.crt</span> in the server's data directory</>}). Give that file to the one command that calls the API, as
          below (the examples run where <span className="font-mono">tls.crt</span> is); Node programs take <span className="font-mono">NODE_EXTRA_CA_CERTS=tls.crt</span>.
          Keep certificate checks on. The examples read the key from the environment variable <span className="font-mono">OPENINFER_API_KEY</span>.
          The answer comes from the session's devices, which are simulated here: it is the simulator's fixed text.
        </p>
        <Example title="curl">{curl}</Example>
        <Example title="Python (openai package)">{python}</Example>
        <Example title="Run the Python example">{'SSL_CERT_FILE=tls.crt python chat.py'}</Example>
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-muted-foreground">
          <li>Start a session on the Sessions page first. Without a running session the API answers 503.</li>
          <li>A session runs one request at a time, from this website or a program. A busy session answers 429 with Retry-After; clients retry.</li>
          <li>Each request has {context ?? 'a fixed number of'} tokens for the prompt, the thinking and the answer together. A larger maximum output is cut to what fits.</li>
          <li>The output is sampled: temperature must be above 0 (the default is 1.0).</li>
          <li>Closing the connection, as a chat client's Stop button does, cancels the request.</li>
        </ul>
      </CardContent>
    </Card>
  );
}
