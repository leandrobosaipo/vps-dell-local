# Recarga nativa excepcional

Ferramenta administrativa para uma única chamada explicitamente autorizada a
`reloadConnection` de um cliente existente. Não é serviço, endpoint, rotina de
reconexão, provisionador de instâncias nem autorização para aplicá-la.

O operador deve provar fora desta ferramenta que os consumidores/emissores estão
parados, que o recebimento está preservado, que há custódia consistente da sessão
e que identidade, código instalado e transporte fechado correspondem ao alvo.
Os hashes esperados e a prova do fechamento anterior não são descobertos nem
inventados pelo executor. Um socket ausente exige evidência explícita de um
fechamento anterior concluído; ausência isolada não basta.

`evolution-native-runner.mjs` localiza o controlador já existente pelo Inspector
local, sem importar outra aplicação, alterar handlers ou chamar o endpoint de
restart. O retorno nativo do método contém segredos e é descartado. Só metadados
saem do processo. O Inspector preexistente é preservado; o aberto pelo executor
é fechado ao final e deve ser conferido independentemente.

Um claim persistente exclusivo é gravado e sincronizado antes da chamada. Falha
ou resultado incerto consomem a tentativa. Nunca apagar o claim para repetir.
Se a identidade mudar ou surgir novo pedido de pareamento, fecha-se apenas o
novo cliente e bloqueia-se sua reconexão; não há logout, QR exposto ou novo login.
Reconexões/retransmissões nativas de protocolo não são novas chamadas explícitas.

Testes: `node --test --test-concurrency=1 maintenance/test_native_*.mjs` em Linux.
As fixtures usam contas fictícias, servidor local e diretórios temporários;
não usam a sessão real. Teste não comprova entrega ou autoriza retomada da operação.
