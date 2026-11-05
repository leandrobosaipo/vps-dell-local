# VPS Dell local

## Escopo

Servidor Dell local com Windows preservado e Ubuntu em Hyper-V. Este projeto guarda configuração e acesso próprios; infraestrutura compartilhada de bootstrap permanece em codigo5-agentes-infra. Não operar Mac Mini, JP, Evolution, portais ou outros clientes por consequência deste trabalho.

## Operação

- Leia fontes, remoto, estado e recibos reais antes de mudar serviços. Preserve Windows, dados, WSL e credenciais preexistentes.
- Use a VM pelo ID comprovado; não renomeie diretórios, discos ou identidades para mudar apenas o nome apresentado ao usuário.
- Publique fontes sanitizadas e configuração no GitHub e confira SHA/checks antes de aplicar. Use recibos por etapa e readback do serviço e do consumidor.
- Avalie Rust para componentes novos; prefira ferramentas nativas prontas para administração, sem criar executor web de shell próprio.
- Cloudflare Tunnel deve executar no Dell/Ubuntu, como serviço persistente, sem depender do notebook ou do Mac Mini. Painel exige autenticação; não expor Docker socket, banco ou terminal sem proteção.
- Não abrir portas no roteador nem reiniciar o Windows nesta etapa. Início automático da VM pode ser configurado, mas prova após reinício requer janela própria.
- Acesso cloud/Dot só é confirmado após leitura/ação autenticada nesse ambiente; pasta local ou HTTP200 isolados não provam disponibilidade na nuvem.

## Segredos

- Código e exemplos publicáveis ficam no Git. private/, credenciais, backups, recibos com identidade e arquivos de entrega confidenciais ficam fora do Git, com permissões restritas.
- Nunca imprimir senhas, tokens, chaves privadas, cookies, URL assinada ou conteúdo de .env. Referenciar origem e nomes de campos.
- Gerar credenciais próprias para este projeto; não distribuir credenciais amplas Cloudflare nem chaves antigas como credencial de painel.
- Entrega WhatsApp exclusivamente pelo Código5 Lembretes autorizado, com asset preparado, identidade estável e consulta do mesmo notification_id; aceite não é entrega.

Ao concluir, diferencie DNS/túnel, autenticação, painel, acesso cloud e recibo de WhatsApp. Registre limites e retorno sem inventar prova.
