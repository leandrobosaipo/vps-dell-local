# Retomada SSH e capacidade do piloto — 06/11/2026

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
As aplicações terão somente dados fictícios, rede interna, limites e portas de
loopback. A fonte e os checks do SHA exato precedem qualquer instalação no Dell.

Não há autorização de canais reais, migração ou ativação da operação JP por
consequência desta preparação. O NO_GO do pacote de migração continua valendo
até prova própria de integração, recuperação, writer único e janela autorizada.

## Evidências privadas

`private/access-recovery-20261106/` guarda o readback de Windows/chave,
planejamento/aplicação de capacidade, leitura independente Linux e resumo
reconciliado. Os recibos do host conservam os valores anteriores para retorno.
Não publicar esse diretório nem copiar credenciais para o repositório do piloto.
