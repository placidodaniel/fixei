<div align="right">

🇧🇷 Português | [🇺🇸 English](README.md)

</div>

# Fixei

> *"Corrigiu sozinho."* — Pipeline autônomo de correção de bugs, do ticket ao deploy em produção, sem intervenção humana.

**Autor:** Daniel Plácido
**Licença:** MIT

O Fixei recebe um relatório de bug (GitHub Issue ou Jira), analisa profundamente seu código-fonte usando busca semântica e LLMs, gera uma correção completa, escreve novos testes, abre um Pull Request, aguarda o CI/CD passar, faz o merge automaticamente e fecha o ticket original — tudo sem tocar no teclado.

---

## Sumário

- [Como funciona](#como-funciona)
- [Pipeline de Agentes e Troca de Contexto](#pipeline-de-agentes-e-troca-de-contexto)
  - [Orchestrator](#orchestrator)
  - [TicketAgent](#ticketagent)
  - [DocumentationAgent](#documentationagent)
  - [AnalysisAgent](#analysisagent)
  - [CodeAgent](#codeagent)
  - [TestAgent](#testagent)
  - [DeployAgent](#deployagent)
- [Serviços](#serviços)
  - [VectorStoreService](#vectorstoreservice)
  - [Context7Service](#context7service)
  - [LLMService e Model Fallback](#llmservice-e-model-fallback)
  - [GitHubService](#githubservice)
  - [StateManager](#statemanager)
  - [NotificationService](#notificationservice)
- [Estrutura do Projeto](#estrutura-do-projeto)
- [Início Rápido](#início-rápido)
- [Referência de Configuração](#referência-de-configuração)
- [Rodando em Produção](#rodando-em-produção)
- [Configuração de Webhook](#configuração-de-webhook)
- [API REST](#api-rest)
- [Dashboard](#dashboard)
- [Rodando os Testes](#rodando-os-testes)
- [Considerações de Segurança](#considerações-de-segurança)

---

## Como funciona

```
GitHub Issue / ticket Jira (com a label "ai-fix")
    │
    ▼
[1] TicketAgent          → normaliza e estrutura o ticket bruto
    │
    ▼
[2] DocumentationAgent   → garante que a documentação da codebase está atualizada
    │                       (.bugfix-agent/BACKEND.md + FRONTEND.md)
    │                       dispara rebuild do índice vetorial
    ▼
[3] AnalysisAgent        → busca semântica na codebase + análise por LLM
    │                       confirma a causa raiz, identifica arquivos afetados
    ▼
[4] CodeAgent            → busca conteúdo atual dos arquivos + melhores práticas (Context7)
    │                       gera a correção completa via LLM (formato estruturado)
    │                       cria o branch e commita os arquivos
    ▼
[5] TestAgent            → gera novo arquivo de testes via LLM
    │                       commita os testes, dispara o CI do GitHub Actions
    │                       aguarda resultado (até 10 min)
    ▼  se os testes falharem ──────────────────────────────┐
[6] DeployAgent          → cria PR + labels                 │ loop de retry
    │                       aguarda checks do CI            │ (até MAX_RETRIES)
    │                       merge automático                │
    ▼                                                      ◄┘
[7] TicketAgent          → fecha o ticket como corrigido
    │
    ▼
    Notificação no Slack + comentário de auditoria no GitHub Issue
```

Se todas as tentativas forem esgotadas, o agente **escala** — envia um alerta no Slack, adiciona a label `needs-human` ao ticket e para.

---

## Pipeline de Agentes e Troca de Contexto

Cada agente é uma classe sem estado que recebe dependências pelo construtor. O **Orchestrator** gerencia um objeto `ctx` que acumula resultados a cada etapa e os repassa para o próximo agente. Abaixo estão os dados exatos que fluem entre cada passo.

### Orchestrator

`src/orchestrator.js`

O Orchestrator é dona do ciclo de vida da pipeline. Ele instancia todos os agentes na inicialização e os executa sequencialmente pelo método `run(ticketPayload)`.

O objeto de contexto compartilhado `ctx` evolui ao longo da pipeline:

```js
ctx = {
  runId: "run_1234567890",
  ticket: null,       // ← preenchido pelo TicketAgent
  docs: null,         // ← preenchido pelo DocumentationAgent
  analysis: null,     // ← preenchido pelo AnalysisAgent
  fix: null,          // ← preenchido pelo CodeAgent (atualizado a cada retry)
  tests: null,        // ← preenchido pelo TestAgent
  deploy: null,       // ← preenchido pelo DeployAgent
  retries: 0,
  maxRetries: 3,
  status: 'running',
  auditLog: [],       // ← cada agente adiciona uma entrada
}
```

O `auditLog` é postado como um comentário estruturado no GitHub Issue ao final de cada execução (sucesso ou falha), garantindo rastreabilidade completa.

---

### TicketAgent

`src/agents/ticket-agent.js`

**Entrada:** payload bruto do webhook (formato GitHub Issue ou Jira)

**Saída:**
```js
{
  id: "123",
  title: "Formulário não exibe erros de validação",
  description: "Descrição normalizada completa",
  stepsToReproduce: ["1. Abrir o formulário", "2. Enviar vazio"],
  expectedBehavior: "Deve exibir mensagens de erro",
  actualBehavior: "Formulário falha silenciosamente",
  environment: "production",
  severity: "medium",
  labels: ["ai-fix", "bug"],
  reporter: "joao",
  rawLogs: "...",
  _provider: "github"  // ou "jira"
}
```

O LLM normaliza o ticket bruto em uma estrutura tipada independente do formato de origem. Se o parsing falhar, um fallback extrai os dados diretamente do texto bruto.

**Contexto repassado:** `ctx.ticket` é usado por todos os agentes subsequentes como fonte de verdade sobre o bug.

Também responsável pelos métodos `closeAsFixed()`, `closeAsInvalid()` e `escalate()`, que postam comentários e atualizam o estado do ticket.

---

### DocumentationAgent

`src/agents/documentation-agent.js`

**Entrada:** `ctx.ticket`

**Saída:** string combinada de `BACKEND.md` + `FRONTEND.md`

**O que faz:**

Mantém dois arquivos de documentação viva **dentro do próprio repositório alvo**:

```
(repositório alvo)/
  .bugfix-agent/
    BACKEND.md    ← arquitetura, rotas, serviços, models, auth, filas, padrões
    FRONTEND.md   ← componentes, roteamento, gerenciamento de estado, chamadas API, i18n, build
```

Cada documento tem **11 seções estruturadas** geradas pelo LLM após ler os arquivos-fonte mais relevantes (até 35 arquivos por camada).

**Verificação de desatualização (`_needsUpdate`):** extrai todos os tokens com ≥ 5 caracteres do ticket atual. Se mais de 30% desses tokens estiverem ausentes nos docs existentes, a documentação é considerada desatualizada e regenerada. Isso garante que o índice vetorial sempre tenha contexto relevante para o bug atual.

**Após atualizar os docs:** dispara um rebuild assíncrono do índice do VectorStore para que a busca semântica do AnalysisAgent esteja atualizada.

**Contexto repassado:** `ctx.docs` é injetado no prompt do AnalysisAgent para que o LLM entenda a arquitetura completa antes de analisar o código.

---

### AnalysisAgent

`src/agents/analysis-agent.js`

**Entrada:** `ctx.ticket` + `ctx.docs`

**Saída:**
```js
{
  confirmed: true,
  reason: "Erros de validação são capturados mas não repassados ao componente",
  rootCause: "ContactController retorna 422 mas ContactForm ignora respostas não-2xx",
  codeLocations: ["ContactController.ts:L87", "ContactForm/index.js:L134"],
  affectedFiles: [
    "backend/src/controllers/ContactController.ts",
    "frontend/src/components/ContactForm/index.js"
  ],
  affectedFunctions: ["store()", "handleSubmit()"],
  bugType: "error-handling",
  backendChanges: "Retornar erros de validação no body da resposta sob a chave `errors`",
  frontendChanges: "Ler `errors` da resposta 422 e exibir mensagens por campo",
  suggestedApproach: "Capturar não-2xx no ContactForm, mapear erros para o estado do formulário",
  riskLevel: "low",
  estimatedComplexity: "simple"
}
```

**Como o contexto de código é buscado (`_fetchCodeContext`):**

1. Lista todos os arquivos do repositório via GitHub API
2. Filtra extensões irrelevantes (imagens, lock files, binários, etc.)
3. **Caminho rápido (índice vetorial disponível):** embeds do texto do ticket → `vectorStore.searchPaths()` → busca os top-12 arquivos semanticamente similares em paralelo
4. **Fallback (sem índice):** até 3 rounds de triagem por LLM pedindo 4 arquivos por vez, mais um passo dedicado para frontend se nenhum arquivo `.vue/.jsx/.tsx` foi selecionado
5. O conteúdo completo dos arquivos é concatenado e injetado no prompt de análise

O agente também posta um comentário formatado diretamente no GitHub Issue resumindo a causa raiz e as localizações no código.

**Contexto repassado:** `ctx.analysis` é o handoff mais crítico — diz ao CodeAgent exatamente *o que* corrigir, *onde* e *como*.

---

### CodeAgent

`src/agents/code-agent.js`

**Entrada:** `ctx.analysis` + `ctx.fix.feedback` opcional (detalhes de falha de testes de tentativa anterior)

**Saída:**
```js
{
  branch: "bugfix/auto-1711234567890",
  prTitle: "fix(contacts): exibir erros de validação no ContactForm",
  prDescription: "## Causa Raiz\n...",
  fileChanges: [
    { path: "backend/src/controllers/ContactController.ts", operation: "update", content: "..." },
    { path: "frontend/src/components/ContactForm/index.js", operation: "update", content: "..." }
  ],
  testHints: "Testar tratamento de resposta 422; testar envio de formulário vazio",
  breakingChange: false,
  rollbackPlan: "Reverter PR #N ou cherry-pick do commit anterior do controller",
  feedback: null
}
```

**O que faz:**

1. **Busca o conteúdo atual** de cada `affectedFile` no GitHub
2. **Busca melhores práticas do Context7** (veja [Context7Service](#context7service))
3. **Constrói um prompt estruturado** que inclui:
   - Causa raiz, tipo de bug, nível de risco, abordagem sugerida
   - Descrições de mudanças no backend e frontend (do AnalysisAgent)
   - Feedback de falhas de testes anteriores (em retries)
   - Conteúdo completo dos arquivos atuais
   - Melhores práticas do Context7 para a stack (limitado a ~3000 chars)
4. **Chama o LLM** solicitando um formato de resposta estruturado (sem código embutido em JSON):

```
<<<PLAN>>>
{ "prTitle": "...", "files": [{"path": "...", "operation": "update"}] }
<<<END_PLAN>>>

<<<FILE: backend/src/controllers/ContactController.ts>>>
(conteúdo completo do arquivo — cada linha)
<<<END_FILE>>>

<<<FILE: frontend/src/components/ContactForm/index.js>>>
(conteúdo completo do arquivo)
<<<END_FILE>>>
```

Esse formato separa metadados (JSON) do conteúdo dos arquivos, evitando falhas de parse causadas por chaves TypeScript, template literals e outras sintaxes dentro de strings.

5. **Detecção de truncamento:** se o LLM usou placeholders como `// ...`, `/* existing code */` ou `// unchanged`, o agente executa um passo de merge dedicado (`_expandTruncated`) que combina o arquivo original + o fix parcial em um arquivo completo
6. **Validação de paths:** se o LLM inventou um caminho não existente no repositório, ele é remapeado para o path real mais próximo por nome de arquivo, ou descartado
7. **Criação do branch e commits** via GitHub API

**Passo de recuperação:** se o output do LLM não puder ser parseado (ex: resposta truncada), `_recoverJson()` devolve o texto corrompido ao LLM pedindo para reformatar no formato estruturado.

**Contexto repassado:** `ctx.fix` contém o nome do branch, metadados do PR e a lista de arquivos alterados — usado pelo TestAgent, DeployAgent e pelo auditLog.

---

### TestAgent

`src/agents/test-agent.js`

**Entrada:** `ctx.fix` + `ctx.analysis`

**Saída:**
```js
{
  passed: true,
  total: 24,
  failureDetails: null,  // ou resumo da falha pelo LLM
  newTestsFile: "tests/controllers/ContactController.test.ts",
  ciRunUrl: "https://github.com/owner/repo/actions/runs/12345"
}
```

**O que faz:**

1. **Gera um novo arquivo de testes** — o LLM recebe: a descrição do bug, causa raiz, dicas de testes do CodeAgent e o conteúdo dos arquivos alterados. Produz um arquivo de testes completo (Jest/Vitest/Mocha — inferido dos imports existentes no repo). Path do teste resolvido a partir do source: `src/foo/bar.ts` → `tests/foo/bar.test.ts`

2. **Commita o arquivo de testes** no branch do fix (se `COMMIT_TESTS !== false`)

3. **Dispara o CI do GitHub Actions** — chama `POST /repos/{owner}/{repo}/actions/workflows/{ciWorkflowId}/dispatches`. Em seguida, tenta até **10 vezes** (a cada 5 segundos, totalizando 50 segundos) aguardando o workflow run aparecer na API

4. **Faz polling do status do CI** — verifica a cada 15 segundos até `CI_TIMEOUT_MS` (padrão: 10 minutos). Lê contagem de steps do workflow run para estimar `passed/total`

5. Em caso de falha: **`_interpretFailure(logs)`** — pede ao LLM para resumir a falha em 2-3 frases

**Contexto repassado:** se `tests.passed === false`, o Orchestrator define `ctx.fix.feedback = tests.failureDetails` e volta ao CodeAgent com esse feedback, para que a próxima tentativa corrija as falhas específicas.

---

### DeployAgent

`src/agents/deploy-agent.js`

**Entrada:** `ctx.fix` + `ctx.tests`

**Saída:**
```js
{
  prUrl: "https://github.com/owner/repo/pull/42",
  prNumber: 42,
  branch: "bugfix/auto-1711234567890",
  environment: "production",  // ou "staging" se não fizer merge
  merged: true
}
```

**O que faz:**

1. **Cria um Pull Request** com um body em markdown completo incluindo: descrição, resultados dos testes (contagem de passes), tabela de arquivos alterados, flag de breaking change e plano de rollback
2. **Adiciona labels** `auto-fix` e `bugfix` ao PR
3. **Aguarda os checks do CI** — faz polling do `mergeable_state` a cada 5 segundos por até 60 segundos
4. **Merge automático** usando o método configurado (`squash` / `merge` / `rebase`) se `AUTO_MERGE=true`

---

## Serviços

### VectorStoreService

`src/services/vector-store.js`

Fornece busca semântica nos arquivos do repositório alvo sem nenhum banco de dados vetorial externo.

**Como funciona:**

1. **Chunking:** cada arquivo-fonte é dividido em chunks de ~1200 caracteres com overlap de 200 caracteres
2. **Embeddings:** usa [CodeBERT](https://huggingface.co/Xenova/codebert-base) (`@xenova/transformers`, ~90MB, baixado uma vez e cacheado localmente) para gerar vetores de embeddings de 768 dimensões para cada chunk
3. **Busca por similaridade:** similaridade de cosseno entre o embedding da query e todos os chunks; top-K resultados deduplicados por caminho de arquivo
4. **Persistência:** o índice é salvo em `.bugfix-agent/vector-index.json` dentro do repositório alvo — compartilhado entre execuções

**Fallback TF-IDF:**

Se o modelo CodeBERT não puder ser baixado (restrições de rede, ambientes air-gapped), o serviço muda automaticamente para um modo TF-IDF aprimorado com:
- **Peso 3× para tokens que aparecem no path do arquivo** (ex: uma query por "contato" ranqueia `ContactController.ts` mais alto)
- **Decomposição de camelCase/PascalCase** (`ContactController` → `contact`, `controller`)
- **Matching por prefixo de 5 caracteres** para cognatos PT↔EN (`contato` ↔ `contact`, `clique` ↔ `click`)

O método `scheduleBuild()` aceita uma `Promise<string[]>` para rodar de forma assíncrona enquanto a pipeline continua. `waitReady()` é chamado antes de qualquer busca para garantir que o índice esteja totalmente construído.

---

### Context7Service

`src/services/context7.js`

Injeta documentação atualizada de frameworks e melhores práticas diretamente no prompt do LLM do CodeAgent.

**Por que isso importa:** LLMs têm uma data de corte de treinamento e podem sugerir padrões desatualizados. O Context7 fornece documentação ao vivo para as versões exatas de frameworks em uso, garantindo que o código gerado siga as práticas atuais.

**Como funciona:**

1. O CodeAgent lê `STACK_BACKEND` e `STACK_FRONTEND` das variáveis de ambiente (ex: `TypeScript/NestJS`, `Vue`)
2. `getBestPractices(frameworks, topic, tokensEach)` é chamado com os nomes dos frameworks e um tópico derivado do tipo de bug + abordagem sugerida
3. Para cada framework, `resolveLibrary(name)` mapeia-o para um ID de biblioteca do Context7 usando uma tabela de lookup embutida (TypeScript, Express, Vue, React, Next.js, NestJS, Laravel, Django, FastAPI, Prisma, Mongoose, Jest, Vitest e outros — ou via busca na API para frameworks desconhecidos)
4. Docs são buscados em `https://context7.com/api/v1/{libraryId}?tokens=800&topic=...`
5. Resultados de até 2 frameworks são concatenados e **limitados a ~3000 caracteres** antes de serem injetados no prompt de geração de código

**Se o Context7 estiver indisponível** ou o framework não for encontrado, o agente prossegue sem as melhores práticas — é completamente não-bloqueante.

Para desabilitar: defina `CONTEXT7_ENABLED=false`.

Para configurar o orçamento de tokens por biblioteca: `CONTEXT7_TOKENS=2500` (padrão).

---

### LLMService e Model Fallback

`src/orchestrator.js (classe LLMService)`

Todos os agentes compartilham uma única instância de `LLMService`. Cada chamada passa o `agentName` para que o modelo correto seja selecionado.

```js
llm.call(agentName, systemPrompt, userPrompt, maxTokens)
```

**Fallback nativo do OpenRouter:**

Em vez de implementar lógica de retry na aplicação, o Fixei usa o recurso nativo `models[]` + `route: "fallback"` do [OpenRouter](https://openrouter.ai). O provedor tenta automaticamente o próximo modelo se o primário falhar por limite de quota, rate limiting ou indisponibilidade — zero código de retry na aplicação.

```js
// O que é enviado ao OpenRouter:
{
  models: ["deepseek/deepseek-chat", "qwen/qwen2.5-coder-7b-instruct", "google/gemini-flash-1.5"],
  route: "fallback",
  max_tokens: 16384,
  messages: [...]
}
```

O array é limitado a **3 modelos** (1 primário + 2 fallbacks) — limite da API do OpenRouter.

**Configuração de modelo por agente:**

| Agente | Env Var (primário) | Cadeia de fallback padrão |
|---|---|---|
| analysis | `MODEL_ANALYSIS` | `qwen/qwen2.5-coder-7b-instruct`, `google/gemini-flash-1.5` |
| code | `MODEL_CODE` | `deepseek/deepseek-chat`, `google/gemini-flash-1.5` |
| test | `MODEL_TEST` | `deepseek/deepseek-chat`, `google/gemini-flash-1.5` |
| ticket | `MODEL_TICKET` | `deepseek/deepseek-chat`, `qwen/qwen2.5-coder-7b-instruct` |
| documentation | `MODEL_DOCUMENTATION` | `qwen/qwen2.5-coder-7b-instruct`, `google/gemini-flash-1.5` |

Fallbacks também são configuráveis via env vars (separados por vírgula, sem espaços):

```bash
MODEL_FALLBACKS_CODE=anthropic/claude-3-haiku,google/gemini-flash-1.5
```

Se um modelo de fallback for utilizado, uma entrada `WARN` no log registra qual modelo rodou.

---

### GitHubService

`src/services/github.js`

Wrapper leve da GitHub REST API v3. Todas as chamadas usam o bearer token `GITHUB_TOKEN`.

| Método | Descrição |
|---|---|
| `getFileContent(path)` | Lê um arquivo do branch padrão (decode base64) |
| `createBranch(name)` | Resolve o SHA do HEAD → cria a ref |
| `commitFile(branch, path, content, message)` | Cria ou atualiza um arquivo (busca SHA existente para updates) |
| `listFiles(subPath?)` | Listagem recursiva da árvore → array flat de paths de blobs |
| `getWorkflowRun(runId)` | Busca dados do workflow run do Actions |
| `postAnalysisComment(issueNumber, analysis)` | Posta causa raiz + localizações como comentário formatado no issue |
| `postAuditComment(issueNumber, ctx)` | Posta trilha completa de auditoria da pipeline como comentário no issue |

---

### StateManager

`src/services/state-manager.js`

Persiste o estado das execuções da pipeline em `data/state.json` no disco (upsert por `runId`). Usado pela API REST para servir `/api/runs`.

---

### NotificationService

`src/services/notification.js`

Envia mensagens para o Slack via incoming webhook. Se `SLACK_WEBHOOK_URL` não estiver configurado, as mensagens são impressas no stdout.

---

## Estrutura do Projeto

```
fixei/
├── src/
│   ├── orchestrator.js           # Coordenador da pipeline + LLMService
│   ├── agents/
│   │   ├── ticket-agent.js       # Analisa e gerencia tickets GitHub/Jira
│   │   ├── analysis-agent.js     # Análise de causa raiz + triagem de arquivos
│   │   ├── code-agent.js         # Geração do fix + branch/commit
│   │   ├── test-agent.js         # Geração de testes + polling do CI
│   │   ├── deploy-agent.js       # Criação de PR + auto-merge
│   │   └── documentation-agent.js# Manutenção da documentação da codebase
│   ├── api/
│   │   ├── server.js             # Servidor Express + handlers de webhook
│   │   └── config.js             # Carregador de variáveis de ambiente
│   └── services/
│       ├── github.js             # Wrapper da GitHub REST API
│       ├── vector-store.js       # Índice semântico CodeBERT / TF-IDF
│       ├── context7.js           # Injeção de melhores práticas de frameworks
│       ├── llm-utils.js          # Extrator robusto de JSON para output de LLM
│       ├── state-manager.js      # Persistência de estado (data/state.json)
│       ├── notification.js       # Notificações no Slack
│       └── logger.js             # Logger estruturado com cores ANSI
├── tests/
│   ├── agents/                   # Testes unitários de cada agente
│   └── services/                 # Testes unitários de cada serviço
├── dashboard/
│   └── index.html                # Dashboard de monitoramento em tempo real (JS vanilla)
├── data/                         # Estado de runtime (criado automaticamente, no .gitignore)
│   └── state.json
├── .env.example                  # Template de variáveis de ambiente
├── package.json
└── README.md
```

---

## Início Rápido

### Pré-requisitos

- Node.js 20 ou superior
- Uma conta no [OpenRouter](https://openrouter.ai) e uma API key
- Um Personal Access Token do GitHub com os escopos `repo` e `workflow`
- O **repositório alvo** deve ter GitHub Actions configurado com um workflow de CI

### Instalação

```bash
# 1. Clonar o repositório
git clone https://github.com/danielplacido/fixei.git
cd fixei

# 2. Instalar dependências
npm install

# 3. Configurar variáveis de ambiente
cp .env.example .env
# Edite o .env com suas credenciais (veja Referência de Configuração abaixo)

# 4. Iniciar em modo desenvolvimento (reload automático)
npm run dev
# → Servidor rodando em http://localhost:3000

# 5. Abrir o dashboard de monitoramento
# Abra dashboard/index.html no browser
```

### Disparar manualmente (sem webhook)

```bash
curl -X POST http://localhost:3000/api/trigger \
  -H "Content-Type: application/json" \
  -d '{
    "ticket": {
      "id": "BUG-123",
      "title": "Formulário de contato não exibe erros de validação",
      "description": "Ao enviar um formulário de contato vazio, nenhuma mensagem de erro é exibida. O formulário falha silenciosamente e o usuário não sabe o que houve de errado.",
      "stepsToReproduce": "1. Abrir a tela de Adicionar Contato\n2. Clicar em Salvar sem preencher nenhum campo",
      "expectedBehavior": "Exibir mensagens de erro por campo",
      "actualBehavior": "O formulário fecha ou permanece aberto sem feedback",
      "rawLogs": "POST /contacts → 422 Unprocessable Entity"
    }
  }'
```

---

## Referência de Configuração

### Obrigatórias

| Variável | Descrição |
|---|---|
| `OPENROUTER_API_KEY` | API key em [openrouter.ai/keys](https://openrouter.ai/keys) |
| `GITHUB_TOKEN` | Personal access token — precisa dos escopos `repo` + `workflow` |
| `GITHUB_REPO` | Repositório alvo no formato `owner/repo` |

### Modelos LLM

| Variável | Padrão | Descrição |
|---|---|---|
| `MODEL_ANALYSIS` | `anthropic/claude-3.5-sonnet` | Modelo para análise de causa raiz (raciocínio mais pesado) |
| `MODEL_CODE` | `anthropic/claude-3.5-sonnet` | Modelo para geração de código |
| `MODEL_TEST` | `anthropic/claude-3.5-sonnet` | Modelo para geração de testes |
| `MODEL_TICKET` | `anthropic/claude-3.5-sonnet` | Modelo para parsing de tickets |
| `MODEL_DOCUMENTATION` | igual a `MODEL_ANALYSIS` | Modelo para geração de docs da codebase |
| `MODEL_FALLBACKS_ANALYSIS` | `qwen/qwen2.5-coder-7b-instruct,google/gemini-flash-1.5` | Cadeia de fallback separada por vírgula (máx 2) |
| `MODEL_FALLBACKS_CODE` | `deepseek/deepseek-chat,google/gemini-flash-1.5` | |
| `MODEL_FALLBACKS_TEST` | `deepseek/deepseek-chat,google/gemini-flash-1.5` | |
| `MODEL_FALLBACKS_TICKET` | `deepseek/deepseek-chat,qwen/qwen2.5-coder-7b-instruct` | |
| `MODEL_FALLBACKS_DOCUMENTATION` | `qwen/qwen2.5-coder-7b-instruct,google/gemini-flash-1.5` | |

Veja os modelos disponíveis em [openrouter.ai/models](https://openrouter.ai/models).

### Stack de Tecnologia (para o Context7)

| Variável | Exemplo | Descrição |
|---|---|---|
| `STACK_BACKEND` | `TypeScript/NestJS` | Linguagem/framework backend — usado para buscar melhores práticas |
| `STACK_FRONTEND` | `Vue` | Framework frontend — usado para buscar melhores práticas |
| `CONTEXT7_ENABLED` | `true` | Defina `false` para desabilitar a injeção de melhores práticas |
| `CONTEXT7_TOKENS` | `2500` | Máximo de tokens buscados por biblioteca no Context7 |

### GitHub

| Variável | Padrão | Descrição |
|---|---|---|
| `DEFAULT_BRANCH` | `main` | Branch de onde o agente lê o código e cria branches de fix |
| `GITHUB_WEBHOOK_SECRET` | — | Secret HMAC para verificação de assinatura de webhook (fortemente recomendado) |
| `TRIGGER_LABEL` | `ai-fix` | Label do GitHub Issue que ativa a pipeline |
| `CI_WORKFLOW_ID` | `ci.yml` | Nome do arquivo do workflow do GitHub Actions que o agente dispara |
| `CI_TIMEOUT_MS` | `600000` | Tempo máximo aguardando o CI (milissegundos) |
| `AUTO_MERGE` | `true` | Merge automático do PR quando o CI passar |
| `MERGE_METHOD` | `squash` | `squash` / `merge` / `rebase` |
| `DEPLOY_ENV` | `production` | Label exibido nas notificações quando o merge for feito |

### Comportamento da Pipeline

| Variável | Padrão | Descrição |
|---|---|---|
| `MAX_RETRIES` | `3` | Máximo de tentativas antes de escalar para um humano |
| `COMMIT_TESTS` | `true` | Defina `false` para não commitar os testes gerados |

### Fontes de Ticket

| Variável | Padrão | Descrição |
|---|---|---|
| `TICKET_PROVIDER` | `github` | `github` ou `jira` |
| `JIRA_BASE_URL` | — | ex: `https://suaempresa.atlassian.net` |
| `JIRA_EMAIL` | — | E-mail da conta Jira |
| `JIRA_TOKEN` | — | API token do Jira |
| `JIRA_TRANSITION_DONE_ID` | `31` | ID da transição para o status "Concluído" |

### Notificações

| Variável | Padrão | Descrição |
|---|---|---|
| `SLACK_WEBHOOK_URL` | — | URL do incoming webhook do Slack |
| `SLACK_CHANNEL` | `#engineering` | Nome do canal (informativo; definido no próprio webhook) |

---

## Rodando em Produção

### Opção 1 — systemd (Linux VPS)

```ini
# /etc/systemd/system/fixei.service
[Unit]
Description=Fixei
After=network.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/opt/fixei
EnvironmentFile=/opt/fixei/.env
ExecStart=/usr/bin/node src/api/server.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now fixei
sudo journalctl -u fixei -f
```

### Opção 2 — Docker

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "src/api/server.js"]
```

```bash
docker build -t fixei .
docker run -d \
  --name fixei \
  --env-file .env \
  -p 3000:3000 \
  -v fixei-data:/app/data \
  fixei
```

### Opção 3 — PM2

```bash
npm install -g pm2
pm2 start src/api/server.js --name fixei
pm2 save
pm2 startup
```

### Checklist de produção

- [ ] Definir `GITHUB_WEBHOOK_SECRET` — o servidor verifica HMAC-SHA256 em cada webhook
- [ ] O servidor precisa ser publicamente acessível pelo GitHub (use um reverse proxy como Nginx ou um túnel como Cloudflare Tunnel para redes privadas)
- [ ] O diretório `data/` precisa ter permissão de escrita (persistência de estado e cache do índice vetorial)
- [ ] A primeira execução baixará o modelo CodeBERT (~90MB) — pré-aqueça com: `node -e "import('./src/services/vector-store.js')"`
- [ ] Revise `MAX_RETRIES` e `CI_TIMEOUT_MS` conforme a velocidade do seu CI
- [ ] Defina `STACK_BACKEND` e `STACK_FRONTEND` para injeção otimizada de melhores práticas via Context7

### Reverse proxy (exemplo com Nginx)

```nginx
server {
    listen 80;
    server_name fixei.suaempresa.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 300s;  # tempo suficiente para o polling do CI
    }
}
```

---

## Configuração de Webhook

### GitHub

1. Vá ao **repositório alvo** → Settings → Webhooks → Add webhook
2. **Payload URL:** `https://seu-servidor.com/webhook/github`
3. **Content type:** `application/json`
4. **Secret:** mesmo valor de `GITHUB_WEBHOOK_SECRET` no seu `.env`
5. **Events:** selecione apenas "Issues"
6. Crie a label `ai-fix` no repositório (Issues → Labels → New label)

Qualquer issue com a label `ai-fix` adicionada dispara a pipeline automaticamente.

### Jira

1. Vá ao Jira → Settings → System → Webhooks → Create a WebHook
2. **URL:** `https://seu-servidor.com/webhook/jira`
3. **Events:** Issue Created, Issue Updated
4. **Filter (opcional):** `labels = "ai-fix"`

---

## API REST

| Método | Endpoint | Descrição |
|---|---|---|
| `GET` | `/health` | Health check: `{ ok: true, ts: "..." }` |
| `POST` | `/webhook/github` | Receptor de webhook do GitHub Issues |
| `POST` | `/webhook/jira` | Receptor de webhook do Jira |
| `POST` | `/api/trigger` | Disparo manual: `{ ticket: {...} }` — síncrono, retorna resultado da pipeline |
| `GET` | `/api/runs` | Lista todas as execuções (ordenadas por `updatedAt` desc) |
| `GET` | `/api/runs/:runId` | Detalhes completos de uma execução incluindo o auditLog |

---

## Dashboard

Abra `dashboard/index.html` diretamente no browser (sem build necessário). Conecta em `http://localhost:3000` por padrão.

**Funcionalidades:**
- Lista ao vivo de todas as execuções com status colorido (verde = sucesso, vermelho = erro, âmbar = rodando, roxo = escalado)
- Detalhe por execução: trilha completa de auditoria de cada etapa da pipeline, arquivos alterados, link do PR, link do CI run, detalhes de falhas
- Polling automático — atualiza em tempo real sem refresh manual

---

## Rodando os Testes

```bash
# Rodar todos os testes com relatório de cobertura
npm test

# Rodar sem cobertura (mais rápido)
npm test -- --no-coverage

# Rodar um arquivo de teste específico
npm test -- tests/agents/code-agent.test.js
```

A suíte de testes cobre todos os 6 agentes e todos os serviços (13 arquivos de teste, ~197 assertions). O GitHub service e o servidor Express são intencionalmente excluídos da cobertura pois exigem chamadas de API reais.

---

## Considerações de Segurança

- **Verificação de webhook:** todos os webhooks do GitHub são verificados com HMAC-SHA256 (`crypto.timingSafeEqual`). Sempre defina `GITHUB_WEBHOOK_SECRET`.
- **Escopo do token:** o token do GitHub precisa apenas dos escopos `repo` + `workflow`. Não use um token com permissões de admin ou org.
- **Arquivo `.env`:** nunca faça commit do seu `.env`. Ele contém API keys. O `.gitignore` deste repositório o exclui.
- **Arquivo de estado:** `data/state.json` pode conter títulos de tickets e URLs de PRs. Mantenha o diretório `data/` privado.
- **Output do LLM:** o código gerado é commitado em um branch e passa pelo CI antes do merge. A pipeline nunca faz push diretamente no branch principal.
- **Auto-merge:** se o seu CI não for abrangente, defina `AUTO_MERGE=false` e revise os PRs manualmente.
- **CORS:** a API tem CORS aberto para o dashboard local. Se você expor a API publicamente, restrinja o CORS a origens conhecidas.
