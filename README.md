# 🤖 BugFix Agent

Pipeline autônomo de correção de bugs — do ticket ao deploy, sem intervenção humana.

## Como funciona

```
Ticket criado (Jira/GitHub)
    → Webhook dispara o pipeline
    → Agente lê e valida o bug
    → Claude analisa a codebase e confirma o problema
    → Claude Code gera o fix em um branch
    → CI/CD roda os testes (+ novos testes gerados pelo Claude)
    → PR criado e mergeado automaticamente
    → Ticket fechado + cliente notificado no Slack
```

Se o fix falhar nos testes, o agente tenta novamente até `MAX_RETRIES` vezes.
Se esgotar as tentativas, escala para um humano via Slack e label no ticket.

## Requisitos

- Node.js 20+
- Conta na [Anthropic API](https://console.anthropic.com)
- Repositório no GitHub com GitHub Actions configurado
- (Opcional) Jira e Slack

## Setup rápido

```bash
# 1. Instalar dependências
npm install

# 2. Configurar variáveis de ambiente
cp .env.example .env
# Edite .env com suas credenciais

# 3. Iniciar
npm run dev
# Servidor rodando em http://localhost:3000

# 4. Dashboard
# Abra dashboard/index.html no browser
```

## Variáveis de ambiente

| Variável              | Obrigatório | Descrição |
|-----------------------|-------------|-----------|
| `ANTHROPIC_API_KEY`   | ✅          | API key do Claude |
| `GITHUB_TOKEN`        | ✅          | Token GitHub (repo + workflow) |
| `GITHUB_REPO`         | ✅          | `owner/repo` |
| `DEFAULT_BRANCH`      | —           | Branch principal (padrão: `main`) |
| `TRIGGER_LABEL`       | —           | Label que ativa o pipeline (padrão: `ai-fix`) |
| `CI_WORKFLOW_ID`      | —           | Arquivo do workflow CI (padrão: `ci.yml`) |
| `AUTO_MERGE`          | —           | Auto-merge quando CI passar (padrão: `true`) |
| `MAX_RETRIES`         | —           | Máximo de tentativas (padrão: `3`) |
| `SLACK_WEBHOOK_URL`   | —           | Webhook para notificações |
| `TICKET_PROVIDER`     | —           | `github` ou `jira` |
| `JIRA_BASE_URL`       | —           | URL do Jira (se provider=jira) |

## Webhook no GitHub

1. Repositório → **Settings → Webhooks → Add webhook**
2. URL: `http://SEU_SERVIDOR:3000/webhook/github`
3. Content type: `application/json`
4. Events: selecione **Issues**
5. Crie a label `ai-fix` no repositório

Qualquer issue com a label `ai-fix` aciona o pipeline automaticamente.

## Trigger manual (API)

```bash
curl -X POST http://localhost:3000/api/trigger \
  -H "Content-Type: application/json" \
  -d '{
    "ticket": {
      "id": "BUG-123",
      "title": "Botão não funciona no Safari",
      "description": "...",
      "rawLogs": "TypeError: ..."
    }
  }'
```

## Estrutura do projeto

```
bugfix-agent/
├── src/
│   ├── orchestrator.js          # Coordena todos os agentes
│   ├── agents/
│   │   ├── ticket-agent.js      # Lê tickets do GitHub/Jira
│   │   ├── analysis-agent.js    # Analisa e confirma o bug
│   │   ├── code-agent.js        # Gera o fix com Claude
│   │   ├── test-agent.js        # Roda CI + gera testes
│   │   └── deploy-agent.js      # Cria PR e faz merge
│   ├── api/
│   │   ├── server.js            # Express + webhooks
│   │   └── config.js            # Lê variáveis de ambiente
│   └── services/
│       ├── github.js            # Wrapper da GitHub API
│       ├── notification.js      # Slack notifications
│       ├── state-manager.js     # Persiste estado das runs
│       └── logger.js            # Logger estruturado
├── dashboard/
│   └── index.html               # Dashboard de monitoramento
├── .env.example
└── package.json
```

## Custo estimado (Claude API)

| Volume        | Custo estimado/mês |
|---------------|--------------------|
| 10 bugs/mês   | ~$5–15             |
| 50 bugs/mês   | ~$25–60            |
| 200 bugs/mês  | ~$100–200          |

*Valores aproximados para `claude-sonnet-4-6`. Varia conforme tamanho da codebase.*
