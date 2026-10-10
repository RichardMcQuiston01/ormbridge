-- The canonical blog schema as MySQL DDL.
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE `blog_user` (
  `id` int NOT NULL AUTO_INCREMENT,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `blog_category` (
  `id` int NOT NULL AUTO_INCREMENT,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `name` varchar(100) NOT NULL,
  `slug` varchar(50) NOT NULL,
  `parent_id` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `name` (`name`),
  KEY `blog_category_parent_id_idx` (`parent_id`),
  CONSTRAINT `blog_category_parent_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `blog_category` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `blog_tag` (
  `id` int NOT NULL AUTO_INCREMENT,
  `label` varchar(50) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `blog_post` (
  `id` int NOT NULL AUTO_INCREMENT,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `public_id` char(36) NOT NULL DEFAULT (UUID()),
  `title` varchar(200) NOT NULL,
  `body` longtext NOT NULL COMMENT 'The post text',
  `status` enum('draft','published') NOT NULL DEFAULT 'draft',
  `rating` decimal(4,2) DEFAULT NULL,
  `view_count` int unsigned NOT NULL DEFAULT '0',
  `is_featured` tinyint(1) NOT NULL DEFAULT '0',
  `published_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `metadata` json NOT NULL,
  `author_id` int NOT NULL,
  `editor_id` int DEFAULT NULL,
  `category_id` int NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `public_id` (`public_id`),
  UNIQUE KEY `blog_post_author_id_title_key` (`author_id`,`title`),
  KEY `blog_post_title_idx` (`title`),
  KEY `post_pub_status_idx` (`published_at`,`status`),
  KEY `editor_id` (`editor_id`),
  KEY `category_id` (`category_id`),
  CONSTRAINT `blog_post_author_id_fk` FOREIGN KEY (`author_id`) REFERENCES `blog_user` (`id`) ON DELETE CASCADE,
  CONSTRAINT `blog_post_editor_id_fk` FOREIGN KEY (`editor_id`) REFERENCES `blog_user` (`id`) ON DELETE SET NULL,
  CONSTRAINT `blog_post_category_id_fk` FOREIGN KEY (`category_id`) REFERENCES `blog_category` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB AUTO_INCREMENT=12 DEFAULT CHARSET=utf8mb4 COMMENT='Posts written by users';

CREATE TABLE `blog_profile` (
  `id` int NOT NULL AUTO_INCREMENT,
  `bio` text,
  `avatar` varchar(100) DEFAULT NULL,
  `user_id` int NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `user_id` (`user_id`),
  CONSTRAINT `blog_profile_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `blog_user` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `blog_post_tags` (
  `post_id` int NOT NULL,
  `tag_id` int NOT NULL,
  PRIMARY KEY (`post_id`,`tag_id`),
  CONSTRAINT `blog_post_tags_post_id_fk` FOREIGN KEY (`post_id`) REFERENCES `blog_post` (`id`) ON DELETE CASCADE,
  CONSTRAINT `blog_post_tags_tag_id_fk` FOREIGN KEY (`tag_id`) REFERENCES `blog_tag` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;
