#!/bin/sh
# Roda quando o LocalStack fica pronto. Idempotente: create-queue com os mesmos
# atributos devolve a fila existente, entao reinicio do container nao quebra.
set -eu

# A sintaxe abreviada de --attributes nao aceita o JSON aninhado do RedrivePolicy,
# por isso os atributos vao em arquivo JSON montado com python3 (que o LocalStack
# tem por construcao).

DLQ_URL=$(awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes '{"FifoQueue":"true","MessageRetentionPeriod":"1209600"}' \
  --query QueueUrl --output text)

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' --output text)

python3 - "$DLQ_ARN" > /tmp/main-queue-attrs.json <<'PY'
import json, sys
print(json.dumps({
    "FifoQueue": "true",
    "VisibilityTimeout": "30",
    "MessageRetentionPeriod": "1209600",
    "RedrivePolicy": json.dumps({
        "deadLetterTargetArn": sys.argv[1],
        "maxReceiveCount": "5",
    }),
}))
PY

MAIN_URL=$(awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes file:///tmp/main-queue-attrs.json \
  --query QueueUrl --output text)

# Fila de eventos de integracao publicados pela outbox, com sua propria DLQ.
EVENTS_DLQ_URL=$(awslocal sqs create-queue \
  --queue-name wager-events-dlq.fifo \
  --attributes '{"FifoQueue":"true","MessageRetentionPeriod":"1209600"}' \
  --query QueueUrl --output text)

EVENTS_DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$EVENTS_DLQ_URL" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' --output text)

python3 - "$EVENTS_DLQ_ARN" > /tmp/events-queue-attrs.json <<'PY2'
import json, sys
print(json.dumps({
    "FifoQueue": "true",
    "VisibilityTimeout": "30",
    "MessageRetentionPeriod": "1209600",
    "RedrivePolicy": json.dumps({
        "deadLetterTargetArn": sys.argv[1],
        "maxReceiveCount": "5",
    }),
}))
PY2

EVENTS_URL=$(awslocal sqs create-queue \
  --queue-name wager-events.fifo \
  --attributes file:///tmp/events-queue-attrs.json \
  --query QueueUrl --output text)

# Filas da suite de testes, para que os workers do Compose nao competam com
# ela pelas mesmas mensagens.
for sufixo in transactions-test events-test; do
  awslocal sqs create-queue \
    --queue-name "wager-$sufixo-dlq.fifo" \
    --attributes '{"FifoQueue":"true","MessageRetentionPeriod":"3600"}' >/dev/null
  TEST_DLQ_ARN=$(awslocal sqs get-queue-attributes \
    --queue-url "http://localhost:4566/000000000000/wager-$sufixo-dlq.fifo" \
    --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)
  python3 - "$TEST_DLQ_ARN" > /tmp/test-queue-attrs.json <<'PY3'
import json, sys
print(json.dumps({
    "FifoQueue": "true",
    "VisibilityTimeout": "10",
    "MessageRetentionPeriod": "3600",
    "RedrivePolicy": json.dumps({"deadLetterTargetArn": sys.argv[1], "maxReceiveCount": "5"}),
}))
PY3
  awslocal sqs create-queue \
    --queue-name "wager-$sufixo.fifo" \
    --attributes file:///tmp/test-queue-attrs.json >/dev/null
done

echo "init-queues: filas de teste criadas (sufixo -test)"
echo "init-queues: DLQ        = $DLQ_URL"
echo "init-queues: MAIN       = $MAIN_URL"
echo "init-queues: EVENTS     = $EVENTS_URL"
echo "init-queues: EVENTS_DLQ = $EVENTS_DLQ_URL"
awslocal sqs get-queue-attributes --queue-url "$MAIN_URL" \
  --attribute-names RedrivePolicy VisibilityTimeout FifoQueue
