-- MySQL / MariaDB: a mysqldump-like script.
/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET NAMES utf8mb4 */;

# a MySQL hash comment
DROP TABLE IF EXISTS `forum_user`;
CREATE TABLE `forum_user` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `handle` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `role` enum('member','moderator','admin') NOT NULL DEFAULT 'member',
  `perms` set('read','write') DEFAULT NULL,
  `karma` int(11) NOT NULL DEFAULT '0',
  `active` bit(1) NOT NULL DEFAULT b'1',
  `last_seen` timestamp NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  `bio` mediumtext,
  `avatar` blob,
  `score` double(8,2) DEFAULT NULL,
  `born` year(4) DEFAULT NULL,
  `quote` varchar(255) DEFAULT 'he said \'hi\'',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_handle` (`handle`),
  FULLTEXT KEY `ft_bio` (`bio`)
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `forum_thread` (
  `id` int NOT NULL AUTO_INCREMENT,
  `author_id` bigint unsigned NOT NULL,
  `parent_thread_id` int DEFAULT NULL,
  `title` varchar(200) NOT NULL,
  `status` enum('open','closed') NOT NULL DEFAULT 'open',
  `created` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_title` (`title`(20)),
  KEY `idx_author_created` (`author_id`,`created` DESC),
  CONSTRAINT `fk_thread_author` FOREIGN KEY (`author_id`) REFERENCES `forum_user` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT `fk_thread_parent` FOREIGN KEY (`parent_thread_id`) REFERENCES `forum_thread` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE `forum_follow` (
  `follower_id` bigint unsigned NOT NULL,
  `followee_id` bigint unsigned NOT NULL,
  PRIMARY KEY (`follower_id`,`followee_id`),
  CONSTRAINT `fk_follower` FOREIGN KEY (`follower_id`) REFERENCES `forum_user` (`id`),
  CONSTRAINT `fk_followee` FOREIGN KEY (`followee_id`) REFERENCES `forum_user` (`id`)
) ENGINE=InnoDB;

LOCK TABLES `forum_user` WRITE;
INSERT INTO `forum_user` VALUES (1,'alice','admin',NULL,5,1,NULL,'hi; there',NULL,NULL,NULL,NULL);
UNLOCK TABLES;

DELIMITER ;;
CREATE TRIGGER `forum_user_bi` BEFORE INSERT ON `forum_user` FOR EACH ROW
BEGIN
  SET NEW.karma = IFNULL(NEW.karma, 0);
  CREATE TABLE ignored_inside_trigger (x int);
END ;;
DELIMITER ;

ALTER TABLE `forum_thread` ADD COLUMN `pinned` tinyint(1) NOT NULL DEFAULT 0;
ALTER TABLE `forum_thread` ADD UNIQUE KEY `uniq_title_author` (`title`, `author_id`);
