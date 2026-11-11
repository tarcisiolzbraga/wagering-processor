/**
 * Filho que morre antes de chegar na barreira.
 *
 * Existe para o harness poder provar que diagnostica esse caso em vez de ficar
 * pendurado esperando uma largada que nunca vai acontecer.
 */
console.error("falhei na inicializacao de proposito");
process.exit(1);
