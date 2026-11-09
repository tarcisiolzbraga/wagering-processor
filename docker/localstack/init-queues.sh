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

echo "init-queues: DLQ  = $DLQ_URL"
echo "init-queues: MAIN = $MAIN_URL"
awslocal sqs get-queue-attributes --queue-url "$MAIN_URL" \
  --attribute-names RedrivePolicy VisibilityTimeout FifoQueue
