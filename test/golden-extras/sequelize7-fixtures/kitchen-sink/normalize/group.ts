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
  BelongsToMany,
  CreatedAt,
  Default,
  NotNull,
  PrimaryKey,
  Table,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';

@Table({ tableName: 'group', timestamps: true, underscored: true })
export class Group extends Model<
  InferAttributes<Group>,
  InferCreationAttributes<Group>
> {
  @Attribute(DataTypes.UUID)
  @PrimaryKey
  @Default(DataTypes.UUIDV4)
  declare id: CreationOptional<string>;

  @Attribute(DataTypes.STRING(40))
  @NotNull
  declare name: string;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;

  @BelongsToMany(() => Group, {
    through: { model: 'group_friends', timestamps: false },
    foreignKey: 'from_group_id',
    otherKey: 'to_group_id',
    inverse: 'friendOf',
    throughAssociations: { fromSource: 'friendsLinks', toSource: 'friendsSource', fromTarget: 'friendOfLinks', toTarget: 'friendsTarget' },
  })
  declare friends?: NonAttribute<Group[]>;

  declare friendOf?: NonAttribute<Group[]>;
}
