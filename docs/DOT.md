# Continuidade no Dot e no Codex

Abra a Página pessoal **VPS Dell local**, fornecida pelo usuário na mesma conta. A Página contém referências privadas ao JSON de acesso e às instruções de login, além de um bloco de instruções do agente. A leitura desses arquivos foi verificada pelo conector em nuvem e comparada por digest, sem depender da pasta local.

Use a ferramenta Pages para ler a Página e `read_page_reference` com a referência exata observada para obter o arquivo. Mantenha valores apenas em memória privada; nunca imprima senhas, cookies, tokens ou cabeçalhos de autenticação. A Página e seus arquivos não devem ser compartilhados. Se essas ferramentas não estiverem expostas na sessão, declare o limite; não invente acesso ao filesystem do notebook.

O JSON privado contém `url`, `username`, `password` e `cloudflare.clientId/clientSecret/expiresAt`. O service token só concede entrada nesta aplicação Access; o PAM continua necessário. Para login humano, siga as instruções privadas: OTP do e-mail proprietário e depois o usuário/senha do Cockpit. Token do conector e chave global Cloudflare não fazem parte desse arquivo de acesso.

Validação somente leitura pelo protocolo oficial Cockpit:

```bash
python3 -m pip install -r requirements-probe.txt
python3 cloudflare/check_external.py --credentials /caminho/privado/dot-access.json
```

O probe confere bloqueio anônimo, autenticação de serviço e PAM, abre o WebSocket e executa somente `id -un`, `hostname` e leitura do nome de apresentação. Não é um executor genérico de shell. O workflow manual de prova em nuvem usa credencial temporária; o segredo de teste foi removido do GitHub após a prova.

Para administração, use o terminal/sistema do Cockpit com o usuário autorizado. Antes de alterações duráveis, leia AGENTS.md, publique a fonte/configuração correta, confira SHA/CI e preserve recibos, dados e rollback. Mensagens, dados de clientes, produção antiga e reinício do Windows continuam com seus próprios limites. Um acesso validado não concede autorização para qualquer efeito futuro.

Disponibilidade do endpoint e leitura dos arquivos em nuvem foram comprovadas. A sessão específica do cliente Dot não estava exposta nesta execução; não confundir essa ausência de prova de sessão com dependência do notebook.
