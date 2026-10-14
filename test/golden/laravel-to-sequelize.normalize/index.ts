import type { Sequelize } from 'sequelize';
import { User } from './user.js';
import { Category } from './category.js';
import { Tag } from './tag.js';
import { Post } from './post.js';
import { Profile } from './profile.js';

export { User, Category, Tag, Post, Profile };

/** Initializes every model on a Sequelize instance, then sets up the associations. */
export function initModels(sequelize: Sequelize) {
  User.initModel(sequelize);
  Category.initModel(sequelize);
  Tag.initModel(sequelize);
  Post.initModel(sequelize);
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

  Post.belongsToMany(Tag, {
    as: 'tags',
    through: 'post_tags',
    foreignKey: 'post_id',
    otherKey: 'tag_id',
    timestamps: false,
  });
  Tag.belongsToMany(Post, {
    as: 'posts',
    through: 'post_tags',
    foreignKey: 'tag_id',
    otherKey: 'post_id',
    timestamps: false,
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

  return { User, Category, Tag, Post, Profile };
}

export type Models = ReturnType<typeof initModels>;
