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
    as: 'edited_posts',
    foreignKey: 'editor_id',
    onDelete: 'SET NULL',
  });

  Post.belongsTo(Category, {
    as: 'category',
    foreignKey: 'category_id',
    onDelete: 'RESTRICT',
  });
  Category.hasMany(Post, {
    as: 'post_set',
    foreignKey: 'category_id',
    onDelete: 'RESTRICT',
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

  PostTags.belongsTo(Post, {
    as: 'post',
    foreignKey: 'post_id',
    onDelete: 'CASCADE',
  });
  Post.hasMany(PostTags, {
    as: 'tags',
    foreignKey: 'post_id',
    onDelete: 'CASCADE',
  });

  PostTags.belongsTo(Tag, {
    as: 'tag',
    foreignKey: 'tag_id',
    onDelete: 'CASCADE',
  });
  Tag.hasMany(PostTags, {
    as: 'posts',
    foreignKey: 'tag_id',
    onDelete: 'CASCADE',
  });

  return { Category, Post, Tag, Profile, User, PostTags };
}

export type Models = ReturnType<typeof initModels>;
