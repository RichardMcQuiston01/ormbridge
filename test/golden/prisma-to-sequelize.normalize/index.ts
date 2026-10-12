import type { Sequelize } from 'sequelize';
import { Category } from './category.js';
import { Post } from './post.js';
import { Tag } from './tag.js';
import { Profile } from './profile.js';
import { User } from './user.js';
import { PostTags } from './postTags.js';

export { Category, Post, Tag, Profile, User, PostTags };

/** Initializes every model on a Sequelize instance, then sets up the associations. */
export function initModels(sequelize: Sequelize) {
  Category.initModel(sequelize);
  Post.initModel(sequelize);
  Tag.initModel(sequelize);
  Profile.initModel(sequelize);
  User.initModel(sequelize);
  PostTags.initModel(sequelize);

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
    as: 'postSet',
    foreignKey: 'categoryId',
    onDelete: 'RESTRICT',
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

  PostTags.belongsTo(Post, {
    as: 'post',
    foreignKey: 'postId',
    onDelete: 'CASCADE',
  });
  Post.hasMany(PostTags, {
    as: 'tags',
    foreignKey: 'postId',
    onDelete: 'CASCADE',
  });

  PostTags.belongsTo(Tag, {
    as: 'tag',
    foreignKey: 'tagId',
    onDelete: 'CASCADE',
  });
  Tag.hasMany(PostTags, {
    as: 'posts',
    foreignKey: 'tagId',
    onDelete: 'CASCADE',
  });

  return { Category, Post, Tag, Profile, User, PostTags };
}

export type Models = ReturnType<typeof initModels>;
