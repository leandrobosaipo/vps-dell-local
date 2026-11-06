# Retomada SSH e capacidade do piloto — 06/11/2026

**Atualização posterior:** o usuário autorizou o reboot completo do Windows e
o retorno sem interação manual foi comprovado. Veja o
[registro dessa janela](2026-11-06-reboot-windows-validado.md). Os parágrafos
abaixo sobre boot do host pendente descrevem a preparação anterior à janela.

O login Windows por chave foi comprovado com a identidade de servidor fixada.
O erro final da primeira recuperação era uma comparação textual: o firewall
normaliza `192.168.100.0/24` como `192.168.100.0/255.255.255.0`. A fonte passou
a aceitar somente essas duas representações equivalentes, mantendo a recusa a
redes mais amplas, endereço individual, origem adicional ou `Any`.

Não é necessário repetir a recuperação que já configurou os serviços. O
readback privado confirmou SSH `Running/Automatic`, Hyper-V automático, VM
`Running/Start` com atraso de 30 segundos, chave sem `expiry-time` e conta sem
expiração registrada. Os backups originais e as outras chaves foram preservados.

## Capacidade aplicada

O commit `900c5155412a51cd71913432153e7124a69d3874`, com
[CI 42203752799](https://github.com/leandrobosaipo/vps-dell-local/actions/runs/42203752799)
aprovado, definiu a mudança limitada da VM identificada: 2 → 6 GiB, 2 → 4 vCPUs.
O planejamento exigiu 3 GiB de RAM livre para o host após o incremento e reserva
de 25 GiB para Windows depois do crescimento máximo do VHDX e runtime.
Foi usado cálculo de 64 bits; o caso de crescimento acima de Int32 está coberto
por fixture Windows sem Hyper-V.

Somente o convidado foi desligado de forma limpa e iniciado novamente. O disco
continua com teto de 20 GiB; não se alteraram partições, firmware, Windows, WSL
preexistente, redes físicas ou serviços do Mac Mini. Depois do restart do
convidado, Docker, Cockpit e túnel foram novamente conferidos ativos. A leitura
Linux encontrou aproximadamente 5,79 GiB de RAM utilizável pelo kernel e
15,96 GiB livres no filesystem antes da pilha de aplicações.

Isso prova recuperação do convidado e de seus serviços. Não houve restart do
Windows nem prova de partida sem login após um novo boot do host. Essa prova
continua exigindo janela própria. Disponibilidade depende de energia e Internet;
na tomada, a recuperação configurou suspensão e hibernação por inatividade em
zero e fechamento da tampa sem suspender.

## Separação de projetos

O piloto tem seu próprio [repositório](https://github.com/leandrobosaipo/jp-atendimento-piloto)
e pasta `/Users/leandrobosaipo/Projetos/jp-atendimento-piloto`. Este projeto guarda
a infraestrutura e o acesso ao Dell; as aplicações e fixtures ficam no piloto.
As aplicações usam somente dados fictícios, rede interna, limites e interfaces de
loopback. A fonte e os checks do SHA exato precederam a instalação no Dell.

## Pilha instalada e recuperação comprovada

Release ativa do piloto: `6143d783e8ccb6662965fbef6c06618286637b2a`, com
[CI 42208170971](https://github.com/leandrobosaipo/jp-atendimento-piloto/actions/runs/42208170971)
aprovado. Diretório no convidado: `/opt/atendimento-piloto/source`.

Chatwoot CE/web, Sidekiq, Langflow, n8n, PostgreSQL e Redis estão em execução.
Os seis containers estão somente na bridge interna, sem rota padrão. Três
sockets systemd em 127.0.0.1 dão acesso às interfaces sem conceder saída externa
aos containers. O launcher resolve novamente o IP interno nas ativações e
abandona privilégios antes do encaminhamento. Não foram abertas portas de
roteador nem publicados esses painéis na Internet.

O limite inicial de 1,25 GiB do Langflow causou pressão de memória e demora de
prontidão após o primeiro boot de teste. A atualização dirigida para 1,5 GiB
preservou o volume, os outros cinco containers e todos os registros fictícios.
Os limites somados do Compose passaram a 4,375 GiB.

Um novo reboot somente do Linux validou a configuração final: Docker, Cockpit,
túnel, seis containers e três sockets voltaram, com HTTP 200 nas três interfaces.
O worker registrou heartbeat; não houve OOM ou restart por falha na amostra.
Após esse boot havia aproximadamente 3,12 GB decimais de RAM disponível e
7,76 GB decimais livres em disco. Langflow consumia 1,344/1,5 GiB na amostra;
isso não é benchmark de carga ou garantia para qualquer fluxo.

Contato Chatwoot, fluxo Langflow e workflow n8n fictícios permaneceram presentes
após os reinícios. Cada registro também foi conferido em uma restauração em
banco separado no mesmo PostgreSQL. Não confundir com DR em outra máquina,
backup externo completo ou migração de dados reais.

As credenciais novas ficam no diretório `private/` do convidado (0600), sem
valores neste repositório. Na prova inicial havia somente um workflow
manual/inativo. Depois do reboot autorizado do Windows, a revisão
`95d9df3f0d4513a4ee394e3696c7f281f4f832fc` configurou `America/Cuiaba` na
instância e em um novo webhook sintético autenticado. Veja o
[runbook dos fluxos](https://github.com/leandrobosaipo/jp-atendimento-piloto/blob/95d9df3f0d4513a4ee394e3696c7f281f4f832fc/flows/README.md)
e a [CI dessa revisão](https://github.com/leandrobosaipo/jp-atendimento-piloto/actions/runs/42212188277).
Sete eventos fictícios geraram sete notas privadas, com duplicata, conflito e
saída incerta retidos sem nova nota indevida após restart do clock. Sem
credencial, a requisição recebeu 403 e não gravou evento. Langflow executou
somente um grafo nativo sem provedor. Modelos/API paga, canais reais e dados
da JP não foram conectados. Os recibos locais da base do piloto ficam em
`/Users/leandrobosaipo/Projetos/jp-atendimento-piloto/private/evidence-08f20ae/`.
Os novos fluxos têm recibo próprio em `private/flows-95d9df3/` nesse projeto.

Não há autorização de canais reais, migração ou ativação da operação JP por
consequência desta preparação. O NO_GO do pacote de migração continua valendo
até prova própria de integração, recuperação, writer único e janela autorizada.

## Evidências privadas

`private/access-recovery-20261106/` guarda o readback de Windows/chave,
planejamento/aplicação de capacidade, leitura independente Linux e resumo
reconciliado. Os recibos do host conservam os valores anteriores para retorno.
Não publicar esse diretório nem copiar credenciais para o repositório do piloto.
