import { DataTypes, Model } from '@sequelize/core';
import type {
  InferAttributes,
  InferCreationAttributes,
  NonAttribute,
} from '@sequelize/core';
import { Attribute, NotNull, Table } from '@sequelize/core/decorators-legacy';
import type { Post } from './post.js';

@Table({ tableName: 'blog_tag', timestamps: false })
export class Tag extends Model<
  InferAttributes<Tag>,
  InferCreationAttributes<Tag>
> {
  @Attribute(DataTypes.STRING(50))
  @NotNull
  declare label: string;

  // The other side of Post.tags (its `inverse` option defines this).
  declare posts?: NonAttribute<Post[]>;
}
