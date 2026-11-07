# Decisões do piloto JP e limites da infraestrutura

Registro de 07/11/2026. As decisões funcionais e os critérios de homologação
estão no [projeto do piloto JP](https://github.com/leandrobosaipo/jp-atendimento-piloto/blob/main/docs/2026-11-07-decisoes-e-homologacao.md).
Este repositório mantém somente o contexto necessário à infraestrutura Dell.

## Decisões relevantes

- Evolution API e a sessão WhatsApp permanecem no Mac Mini Server, conforme
  determinação do usuário. A sessão foi informada como autenticada pelo usuário;
  este registro não é uma nova verificação de conexão.
- O usuário aprovou as respostas às perguntas sugeridas que testou no painel.
  Não aprovou por esse teste a aparência no WhatsApp, agenda integrada ou envio
  de imagens.
- O atendimento deve enviar mensagens curtas em vários envios, com formatação
  WhatsApp e linguagem natural.
- Em divergência com o AppBarber, vale o preço da imagem aprovada correspondente.
- O objetivo de agenda aprovado é consultar, agendar, alterar e cancelar
  automaticamente. A implementação e os testes de escrita continuam pendentes.
- O objetivo do Clube JP é explicar os planos e realizar adesão automática.
  Implementação, testes e condições comerciais/cobrança ainda serão verificados.
- Devem ser demonstradas três variantes de preços/serviços e três de
  promoção/pacote de manutenção recorrente, com escolha aleatória e variação.

- Casos realmente não resolvidos devem ser encaminhados ao grupo WhatsApp da
  JP, com canal de origem, nome do cliente, resumo e decisão necessária.
  Confirmações básicas de agenda não devem ser encaminhadas por rotina.
  Destino real e condições de segurança/compartilhamento ainda serão verificados.

- O lançamento escolhido é abrir para todos somente após os testes técnicos
  e a revisão final. Não ativar o atendimento real nesta etapa.

## Estado e separação dos projetos

A atualização é somente documental. Não muda serviços, redes, webhooks,
credenciais ou lógica de atendimento; não conecta clientes reais.

O piloto no Dell continua isolado. Na referência consultada, sua revisão
`0197e716571a1bc4d20da2fd03b557aa98a835eb` oferece consultas limitadas do
AppBarber e anexos no Chatwoot, mas não escrita de agenda nem entrega no
WhatsApp. A regra de preço divergente ainda retém o evento para revisão;
aplicar a decisão da imagem aprovada exige alteração futura no projeto do
piloto. Não confundir intenção aprovada com funcionalidade implementada.

A documentação operacional de 06/11 continua como histórico da preparação.
O [reboot Windows validado](2026-11-06-reboot-windows-validado.md) não substitui
a prova de recuperação dos fluxos adicionados depois dele.

## Condições para ativação futura

O [contrato de transição](../migration/README.md) permanece em NO_GO para corte
de produção até homologação do destino, responsabilidade única por processar e
enviar, reconciliação dos recibos e autorização de uma release/janela específica.
Evolution não será transferido para o Dell por consequência dessa transição.

A sequência futura deve preservar os demais serviços, o Windows, os dados,
as sessões e os eventos novos. Nenhuma habilitação de canal real, escrita
AppBarber, envio ou reinício foi executado nesta atualização.
Segredos, artes, dados de clientes e recibos privados continuam fora do Git.
