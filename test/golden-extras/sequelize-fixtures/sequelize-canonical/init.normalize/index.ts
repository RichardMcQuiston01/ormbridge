import type { Sequelize } from 'sequelize';
import { Category } from './category.js';
import { Post } from './post.js';
import { Profile } from './profile.js';
import { Tag } from './tag.js';
import { User } from './user.js';

export { Category, Post, Profile, Tag, User };

/** Initializes every model on a Sequelize instance, then sets up the associations. */
export function initModels(sequelize: Sequelize) {
  Category.initModel(sequelize);
  Post.initModel(sequelize);
  Profile.initModel(sequelize);
  Tag.initModel(sequelize);
  User.initModel(sequelize);

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

  return { Category, Post, Profile, Tag, User };
}

export type Models = ReturnType<typeof initModels>;
