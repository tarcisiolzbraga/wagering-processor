-- Banco separado para a suite de testes.
--
-- Sem isso, os workers do Compose (consumer, outbox-1, outbox-2) competem com
-- os testes pelo mesmo banco e pelas mesmas filas: eles roubam mensagens e
-- publicam linhas da outbox que o teste espera encontrar pendentes. O sintoma
-- e falha intermitente que nao reproduz quando o arquivo roda isolado.
create database wagering_test owner wagering;
