import type { Sequelize } from 'sequelize';
import { User } from './user.js';
import { Category } from './category.js';
import { Post } from './post.js';
import { Tag } from './tag.js';
import { PostTag } from './postTag.js';
import { Profile } from './profile.js';

export { User, Category, Post, Tag, PostTag, Profile };

/** Initializes every model on a Sequelize instance, then sets up the associations. */
export function initModels(sequelize: Sequelize) {
  User.initModel(sequelize);
  Category.initModel(sequelize);
  Post.initModel(sequelize);
  Tag.initModel(sequelize);
  PostTag.initModel(sequelize);
  Profile.initModel(sequelize);

  Category.belongsTo(Category, {
    as: 'parent',
    foreignKey: 'parentId',
    onDelete: 'SET NULL',
  });
  Category.hasMany(Category, {
    as: 'children',
    foreignKey: 'parentId',
    onDelete: 'SET NULL',
  });

  Post.belongsTo(User, {
    as: 'author',
    foreignKey: 'authorId',
    onDelete: 'CASCADE',
  });
  User.hasMany(Post, {
    as: 'posts',
    foreignKey: 'authorId',
    onDelete: 'CASCADE',
  });

  Post.belongsTo(User, {
    as: 'editor',
    foreignKey: 'editorId',
    onDelete: 'SET NULL',
  });
  User.hasMany(Post, {
    as: 'editedPosts',
    foreignKey: 'editorId',
    onDelete: 'SET NULL',
  });

  Post.belongsTo(Category, {
    as: 'category',
    foreignKey: 'categoryId',
    onDelete: 'RESTRICT',
  });
  Category.hasMany(Post, {
    as: 'posts',
    foreignKey: 'categoryId',
    onDelete: 'RESTRICT',
  });

  PostTag.belongsTo(Post, {
    as: 'post',
    foreignKey: 'postId',
    onDelete: 'CASCADE',
  });
  Post.hasMany(PostTag, {
    as: 'tags',
    foreignKey: 'postId',
    onDelete: 'CASCADE',
  });

  PostTag.belongsTo(Tag, {
    as: 'tag',
    foreignKey: 'tagId',
    onDelete: 'CASCADE',
  });
  Tag.hasMany(PostTag, {
    as: 'posts',
    foreignKey: 'tagId',
    onDelete: 'CASCADE',
  });

  Profile.belongsTo(User, {
    as: 'user',
    foreignKey: 'userId',
    onDelete: 'CASCADE',
  });
  User.hasOne(Profile, {
    as: 'profile',
    foreignKey: 'userId',
    onDelete: 'CASCADE',
  });

  return { User, Category, Post, Tag, PostTag, Profile };
}

export type Models = ReturnType<typeof initModels>;
