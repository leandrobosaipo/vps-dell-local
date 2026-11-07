# VPS Dell local

[Decisões do piloto JP de 07/11/2026](docs/2026-11-07-decisoes-piloto-jp.md): Evolution permanece no Mac Mini; decisões funcionais e homologação ficam no projeto do piloto. A publicação documental não libera o corte de produção.

Configuração de acesso e operação do servidor local Dell, preservando o Windows e usando Ubuntu 24.04 em Hyper-V.

Endereço: **https://painel-dell.codigo5.com.br**. Cockpit 314-1 e cloudflared 2026.10.7 estão ativos/habilitados no Dell. O acesso foi verificado por HTTPS e pelo terminal WebSocket, também a partir de um runner em nuvem: [prova 42126914051](https://github.com/leandrobosaipo/vps-dell-local/actions/runs/42126914051).

O conector Cloudflare e o painel rodam no próprio Dell. O notebook é cliente de administração. Cloudflare Access protege a entrada; o Cockpit exige também o login PAM dedicado. Fontes, runbooks sanitizados e manifests ficam neste projeto; segredos e recibos privados permanecem fora do Git. A base compartilhada está em [codigo5-agentes-infra](https://github.com/leandrobosaipo/codigo5-agentes-infra).

O projeto local está registrado no Codex. Uma Página pessoal privada mantém os arquivos de acesso para a mesma conta na nuvem; seus links são entregues privadamente. Nenhuma credencial foi colocada na pasta Google Drive que apresentou compartilhamento com o domínio.

Leia [operação e retorno](docs/OPERACAO.md) e [continuidade no Dot](docs/DOT.md). A configuração inicia a VM 30 segundos após o Windows, mas um reboot real do host ainda não foi testado. O Dell e sua Internet precisam permanecer ativos; o painel administra o Ubuntu, sem oferecer recuperação externa do Windows se a VM estiver parada.

GitHub preserva código. Não substitui backup dos volumes, credenciais, dados ou validação de restauração.
