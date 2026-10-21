import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
} from '@sequelize/core';
import {
  Attribute,
  AutoIncrement,
  BelongsToMany,
  NotNull,
  PrimaryKey,
  Table,
} from '@sequelize/core/decorators-legacy';

@Table({ tableName: 'groups', timestamps: false })
export class Group extends Model<
  InferAttributes<Group>,
  InferCreationAttributes<Group>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<number>;

  @Attribute(DataTypes.STRING(40))
  @NotNull
  declare name: string;

  @BelongsToMany(() => Group, {
    through: { model: 'groups_friends', timestamps: false },
    foreignKey: 'from_group_id',
    otherKey: 'to_group_id',
    inverse: 'friend_of',
    throughAssociations: { fromSource: 'friendsLinks', toSource: 'friendsSource', fromTarget: 'friend_ofLinks', toTarget: 'friendsTarget' },
  })
  declare friends?: NonAttribute<Group[]>;

  declare friend_of?: NonAttribute<Group[]>;
}
