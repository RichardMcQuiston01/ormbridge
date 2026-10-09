<?php

declare(strict_types=1);

namespace App\Entity;

use Doctrine\Common\Collections\ArrayCollection;
use Doctrine\Common\Collections\Collection;
use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity]
#[ORM\Table(name: 'auth_user')]
class User
{
    #[ORM\Id]
    #[ORM\GeneratedValue]
    #[ORM\Column]
    private ?int $id = null;

    /** @var Collection<int, Post> */
    #[ORM\OneToMany(targetEntity: Post::class, mappedBy: 'author')]
    private Collection $posts;

    /** @var Collection<int, Post> */
    #[ORM\OneToMany(targetEntity: Post::class, mappedBy: 'editor')]
    private Collection $editedPosts;

    #[ORM\OneToOne(targetEntity: Profile::class, mappedBy: 'user')]
    private ?Profile $profile = null;

    public function __construct()
    {
        $this->posts = new ArrayCollection();
        $this->editedPosts = new ArrayCollection();
    }
}
