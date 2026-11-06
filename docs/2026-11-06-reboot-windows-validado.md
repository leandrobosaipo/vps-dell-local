# Reboot completo do Windows validado — 06/11/2026

O usuário autorizou reiniciar o Windows do Dell nessa janela. Foi emitido um
único `shutdown.exe /r /t 0`, sem `/f`, depois da captura dos estados Windows,
VM e aplicações. O pedido foi aceito e não foi repetido durante a reconexão.

## Evidência observada

Horários em America/Cuiaba, UTC−04:

| Marco | Horário observado |
|---|---|
| Novo boot do Windows confirmado pelo sistema | 07:30:01 |
| Login SSH autenticado com host-key fixada | 07:30:35 |
| VM Running e configuração Start/delay30 relida | 07:33:11 |
| Painel, três aplicações e dados conferidos no Linux | 07:33:17 |

Esses horários são observações, não garantia de tempo de recuperação. No
primeiro retorno do SSH, a VM ainda constava Off, dentro da partida do serviço
Hyper-V e do atraso configurado. Na leitura seguinte estava Running. Não se
executou Start-VM, Start-Service ou comando equivalente para fazê-la voltar.

O horário de boot do Windows e o boot ID do Linux mudaram em relação à captura
anterior. SSH e Hyper-V voltaram automáticos; a VM conservou 6 GiB/4 vCPUs,
Start/delay30 e parada ShutDown. Docker, Cockpit, Cloudflare Tunnel e os três
sockets de loopback estavam ativos. Os seis containers do piloto voltaram com
os mesmos IDs, e as três interfaces responderam HTTP 200.

Os três registros fictícios originais e suas três cópias restauradas continuaram
presentes. O acesso externo autenticado também abriu o terminal e conferiu
usuário, hostname e nome de apresentação. Não se alteraram chaves de host,
credenciais, rotas de produção ou sessões de WhatsApp.

## Intervenção humana

O Windows registrou eventos de sessão interativa durante sua partida. Para não
inferir que eram manuais, o usuário foi consultado e confirmou **“Deixei sem
tocar”**. Assim, o retorno sem interação manual está apoiado na observação do
usuário e nos recibos técnicos. Não foi necessário mudar configuração de login
automático, guardar senha no registro ou abrir o painel/VM pelo Windows.

## Escopo e preservação

A release das aplicações nesse teste era
`6143d783e8ccb6662965fbef6c06618286637b2a`. A configuração de novos fluxos é uma
etapa posterior com fonte, CI e leitura próprios; este reboot não prova por si
só esses fluxos nem autoriza integração com clientes reais.

Mac Mini, Evolution, n8n compartilhado, agenda e atendimento atuais não foram
alterados. Não houve teste com cliente real, envio, importação de produção ou
contratação. Uma futura reinicialização do Windows continua dependendo de
escopo e janela autorizados; esta permissão não é uma autorização permanente.

Recibos privados locais: `private/host-reboot-20261106/`, incluindo intenção
única, capturas antes/depois, verificações de acesso e a confirmação humana.
Não publicar esse diretório. Para operação, usar as instruções do projeto e a
Página privada de acesso já entregue ao usuário.
