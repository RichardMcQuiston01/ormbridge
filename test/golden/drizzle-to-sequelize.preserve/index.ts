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
    foreignKey: 'parent_id',
    onDelete: 'SET NULL',
  });
  Category.hasMany(Category, {
    as: 'children',
    foreignKey: 'parent_id',
    onDelete: 'SET NULL',
  });

  Post.belongsTo(User, {
    as: 'author',
    foreignKey: 'author_id',
    onDelete: 'CASCADE',
  });
  User.hasMany(Post, {
    as: 'posts',
    foreignKey: 'author_id',
    onDelete: 'CASCADE',
  });

  Post.belongsTo(User, {
    as: 'editor',
    foreignKey: 'editor_id',
    onDelete: 'SET NULL',
  });
  User.hasMany(Post, {
    as: 'editedPosts',
    foreignKey: 'editor_id',
    onDelete: 'SET NULL',
  });

  Post.belongsTo(Category, {
    as: 'category',
    foreignKey: 'category_id',
    onDelete: 'RESTRICT',
  });
  Category.hasMany(Post, {
    as: 'posts',
    foreignKey: 'category_id',
    onDelete: 'RESTRICT',
  });

  PostTag.belongsTo(Post, {
    as: 'post',
    foreignKey: 'post_id',
    onDelete: 'CASCADE',
  });
  Post.hasMany(PostTag, {
    as: 'tags',
    foreignKey: 'post_id',
    onDelete: 'CASCADE',
  });

  PostTag.belongsTo(Tag, {
    as: 'tag',
    foreignKey: 'tag_id',
    onDelete: 'CASCADE',
  });
  Tag.hasMany(PostTag, {
    as: 'posts',
    foreignKey: 'tag_id',
    onDelete: 'CASCADE',
  });

  Profile.belongsTo(User, {
    as: 'user',
    foreignKey: 'user_id',
    onDelete: 'CASCADE',
  });
  User.hasOne(Profile, {
    as: 'profile',
    foreignKey: 'user_id',
    onDelete: 'CASCADE',
  });

  return { User, Category, Post, Tag, PostTag, Profile };
}

export type Models = ReturnType<typeof initModels>;
